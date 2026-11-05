import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { DatabaseCore } from "./database-core";
import { databaseRow, databaseRows, requiredNumberColumn, requiredStringColumn } from "./database-rows";

export interface HostChatRecoveryScope {
  hostId: string;
  userId: string;
  deviceId: string;
  grantId: string;
  capability: "chat";
  hostEpoch: number;
  authEpoch: number;
  grantEpoch: number;
}

export interface HostChatRecoveryTarget {
  agentId: string;
  threadId: string;
}

export interface RecordDurableChatRequestInput {
  scope: HostChatRecoveryScope;
  target: HostChatRecoveryTarget;
  requestId: string;
  content: string;
}

export interface DurableChatReceipt {
  receiptId: string;
  requestId: string;
  messageId: string;
  eventSequence: number;
  acceptedAt: string;
}

export interface HostChatRecoveryCursor {
  scopeKey: string;
  sequence: number;
}

export interface HostChatRecoveryEvent {
  sequence: number;
  messageId: string;
  requestId: string;
  target: HostChatRecoveryTarget;
  content: string;
  occurredAt: string;
}

export interface HostChatRecoverySnapshotRequest {
  sequence: number;
  messageId: string;
  requestId: string;
  target: HostChatRecoveryTarget;
  content: string;
  acceptedAt: string;
}

export interface AcceptedHostChatRequest {
  scopeKey: string;
  requestId: string;
  requestHash: string;
  target: HostChatRecoveryTarget;
  content: string;
}

export interface HostChatRecoverySnapshot {
  type: "host-chat-inbox-snapshot";
  complete: true;
  acceptedRequests: HostChatRecoverySnapshotRequest[];
  cursor: HostChatRecoveryCursor;
}

export type HostChatRecoveryRead =
  | { status: "events"; events: HostChatRecoveryEvent[]; cursor: HostChatRecoveryCursor; hasMore: boolean }
  | {
      status: "snapshot-required";
      reason: "scope-changed" | "cursor-ahead" | "event-gap" | "authorization-changed" | "event-too-large";
    };

export type HostChatRecoveryAuthorization = (scope: HostChatRecoveryScope, target: HostChatRecoveryTarget) => boolean;
export type HostChatRecoveryReadAuthorization = (
  scope: HostChatRecoveryScope,
  target?: HostChatRecoveryTarget,
) => boolean;

export type HostChatRecoverySnapshotAuthorization = HostChatRecoveryReadAuthorization;

const MAX_PAGE_EVENTS = 100;
const MAX_PAGE_BYTES = 1_048_576;
const MAX_EVENT_BYTES = 1_000_000;
const MAX_SNAPSHOT_REQUESTS = 500;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const HostChatRecoveryPayloadSchema = Schema.Struct({
  target: Schema.Struct({ agentId: Schema.String, threadId: Schema.String }),
  content: Schema.String,
});

export class HostChatRecoveryError extends Schema.TaggedError<HostChatRecoveryError>()("HostChatRecoveryError", {
  code: Schema.Literals([
    "UNAUTHORIZED",
    "REQUEST_ID_CONFLICT",
    "INVALID_INPUT",
    "TRANSACTION_ACTIVE",
    "SNAPSHOT_CAPACITY_EXCEEDED",
    "SNAPSHOT_INTEGRITY_FAILURE",
  ]),
}) {}

/** Owns durable, scoped Host inbox receipts and events. It never calls the facade or AgentService. */
export class HostChatRecovery {
  readonly #core: DatabaseCore;

  constructor(options: { core: DatabaseCore }) {
    this.#core = options.core;
  }

  readAcceptedRequest(
    scope: HostChatRecoveryScope,
    requestId: string,
    authorize: HostChatRecoveryReadAuthorization,
  ): AcceptedHostChatRequest {
    validateScope(scope);
    if (!authorize(scope)) throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
    const row = databaseRow(
      this.#core.connection
        .prepare(
          `SELECT request_id AS requestId, request_hash AS requestHash,
                  agent_id AS agentId, thread_id AS threadId, content
           FROM host_chat_recovery_messages WHERE scope_key = ? AND request_id = ?`,
        )
        .get(scopeKeyFor(scope), requestId),
    );
    if (!row) throw new HostChatRecoveryError({ code: "INVALID_INPUT" });
    const target = {
      agentId: requiredStringColumn(row, "agentId"),
      threadId: requiredStringColumn(row, "threadId"),
    };
    if (!authorize(scope, target)) throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
    return {
      scopeKey: scopeKeyFor(scope),
      requestId: requiredStringColumn(row, "requestId"),
      requestHash: requiredStringColumn(row, "requestHash"),
      target,
      content: requiredStringColumn(row, "content"),
    };
  }

  recordDurableChatRequest(
    input: RecordDurableChatRequestInput,
    authorize: HostChatRecoveryAuthorization,
  ): DurableChatReceipt {
    validateScope(input.scope);
    if (!authorize(input.scope, input.target)) throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
    validateInput(input);
    const db = this.#core.connection;
    if (db.isTransaction) throw new HostChatRecoveryError({ code: "TRANSACTION_ACTIVE" });
    const scopeKey = scopeKeyFor(input.scope);
    const scopeJson = canonicalScope(input.scope);
    const requestHash = hash(JSON.stringify([scopeJson, input.target.agentId, input.target.threadId, input.content]));
    db.exec("BEGIN IMMEDIATE");
    try {
      // Recheck under the write lock in case a caller stores the current authorization in this database.
      if (!authorize(input.scope, input.target)) throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
      const previous = readReceipt(
        db
          .prepare(
            `SELECT request_id, message_id, request_hash, event_sequence, accepted_at
             FROM host_chat_recovery_messages WHERE scope_key = ? AND request_id = ?`,
          )
          .get(scopeKey, input.requestId),
      );
      if (previous) {
        if (previous.requestHash !== requestHash) throw new HostChatRecoveryError({ code: "REQUEST_ID_CONFLICT" });
        db.exec("COMMIT");
        return {
          receiptId: `${scopeKey}:${previous.requestId}`,
          requestId: previous.requestId,
          messageId: previous.messageId,
          eventSequence: previous.eventSequence,
          acceptedAt: previous.acceptedAt,
        };
      }

      db.prepare(
        `INSERT INTO host_chat_recovery_scopes(scope_key, scope_json, last_sequence)
         VALUES (?, ?, 0) ON CONFLICT(scope_key) DO NOTHING`,
      ).run(scopeKey, scopeJson);
      const storedScope = db
        .prepare("SELECT scope_json FROM host_chat_recovery_scopes WHERE scope_key = ?")
        .get(scopeKey);
      const storedScopeRow = databaseRow(storedScope);
      if (!storedScopeRow || requiredStringColumn(storedScopeRow, "scope_json") !== scopeJson)
        throw new Error("Host chat recovery scope hash collision.");
      const sequenceRow = databaseRow(
        db
          .prepare(
            `UPDATE host_chat_recovery_scopes SET last_sequence = last_sequence + 1
             WHERE scope_key = ? RETURNING last_sequence`,
          )
          .get(scopeKey),
      );
      const sequence = sequenceRow ? requiredNumberColumn(sequenceRow, "last_sequence") : null;
      if (sequence === null || !Number.isSafeInteger(sequence) || sequence < 1)
        throw new Error("Could not allocate a Host chat event sequence.");
      const acceptedAt = new Date().toISOString();
      const messageId = randomUUID();
      const payloadJson = JSON.stringify({ target: input.target, content: input.content });
      const responseSize = Buffer.byteLength(
        JSON.stringify({
          sequence,
          messageId,
          requestId: input.requestId,
          target: input.target,
          content: input.content,
          occurredAt: acceptedAt,
        }),
        "utf8",
      );
      if (responseSize > MAX_EVENT_BYTES) throw new HostChatRecoveryError({ code: "INVALID_INPUT" });
      db.prepare(
        `INSERT INTO host_chat_recovery_messages
          (scope_key, request_id, message_id, agent_id, thread_id, request_hash, content, accepted_at, event_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        scopeKey,
        input.requestId,
        messageId,
        input.target.agentId,
        input.target.threadId,
        requestHash,
        input.content,
        acceptedAt,
        sequence,
      );
      db.prepare(
        `INSERT INTO host_chat_recovery_events
          (scope_key, sequence, message_id, request_id, event_type, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, 'chat-message-accepted', ?, ?)`,
      ).run(scopeKey, sequence, messageId, input.requestId, payloadJson, acceptedAt);
      db.exec("COMMIT");
      return {
        receiptId: `${scopeKey}:${input.requestId}`,
        requestId: input.requestId,
        messageId,
        eventSequence: sequence,
        acceptedAt,
      };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  readEvents(
    scope: HostChatRecoveryScope,
    after: HostChatRecoveryCursor | undefined,
    authorize: HostChatRecoveryReadAuthorization,
  ): HostChatRecoveryRead {
    validateScope(scope);
    // Scope authorization precedes cursor and event lookups so a denied scope cannot learn stream size.
    if (!authorize(scope)) throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
    const key = scopeKeyFor(scope);
    const db = this.#core.connection;
    if (db.isTransaction) throw new HostChatRecoveryError({ code: "TRANSACTION_ACTIVE" });
    const targets = databaseRows(
      db
        .prepare(
          `SELECT DISTINCT agent_id, thread_id FROM host_chat_recovery_messages
           WHERE scope_key = ? ORDER BY agent_id, thread_id`,
        )
        .all(key),
    );
    // Check every target in the scope before cursor/head lookup, so a stale grant cannot use pagination
    // or cursor errors to learn anything about the old event stream.
    for (const row of targets) {
      if (
        !authorize(scope, {
          agentId: requiredStringColumn(row, "agent_id"),
          threadId: requiredStringColumn(row, "thread_id"),
        })
      )
        return { status: "snapshot-required", reason: "authorization-changed" };
    }
    if (
      after !== undefined &&
      (typeof after !== "object" ||
        after === null ||
        typeof after.scopeKey !== "string" ||
        !Number.isSafeInteger(after.sequence) ||
        after.sequence < 0)
    )
      return { status: "snapshot-required", reason: "cursor-ahead" };
    if (after && after.scopeKey !== key) return { status: "snapshot-required", reason: "scope-changed" };
    const lastRow = databaseRow(
      db.prepare("SELECT last_sequence FROM host_chat_recovery_scopes WHERE scope_key = ?").get(key),
    );
    const last = lastRow ? requiredNumberColumn(lastRow, "last_sequence") : 0;
    const start = after?.sequence ?? 0;
    if (start > last) return { status: "snapshot-required", reason: "cursor-ahead" };
    const page = db
      .prepare(
        `SELECT event.sequence, event.message_id, event.request_id, event.payload_json, event.occurred_at,
                message.agent_id, message.thread_id
         FROM host_chat_recovery_events AS event
         JOIN host_chat_recovery_messages AS message
           ON message.scope_key = event.scope_key AND message.request_id = event.request_id
         WHERE event.scope_key = ? AND event.sequence > ? ORDER BY event.sequence`,
      )
      .iterate(key, start);
    const events: HostChatRecoveryEvent[] = [];
    let pageBytes = 2;
    let expected = start + 1;
    let sawRow = false;
    let stoppedEarly = false;
    for (const value of page) {
      sawRow = true;
      if (events.length >= MAX_PAGE_EVENTS) {
        stoppedEarly = true;
        break;
      }
      const row = databaseRow(value);
      if (!row) throw new Error("Host chat recovery event row is invalid.");
      const sequence = requiredNumberColumn(row, "sequence");
      if (sequence !== expected) return { status: "snapshot-required", reason: "event-gap" };
      const target = {
        agentId: requiredStringColumn(row, "agent_id"),
        threadId: requiredStringColumn(row, "thread_id"),
      };
      if (!authorize(scope, target)) return { status: "snapshot-required", reason: "authorization-changed" };
      const payload = Schema.decodeUnknownSync(HostChatRecoveryPayloadSchema)(
        JSON.parse(requiredStringColumn(row, "payload_json")),
      );
      if (payload.target.agentId !== target.agentId || payload.target.threadId !== target.threadId)
        throw new Error("Host chat recovery event target does not match its accepted message.");
      const event: HostChatRecoveryEvent = {
        sequence,
        messageId: requiredStringColumn(row, "message_id"),
        requestId: requiredStringColumn(row, "request_id"),
        target,
        content: payload.content,
        occurredAt: requiredStringColumn(row, "occurred_at"),
      };
      const encodedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (encodedBytes > MAX_EVENT_BYTES) return { status: "snapshot-required", reason: "event-too-large" };
      const arraySeparatorBytes = events.length > 0 ? 1 : 0;
      if (pageBytes + arraySeparatorBytes + encodedBytes > MAX_PAGE_BYTES) {
        if (events.length === 0) return { status: "snapshot-required", reason: "event-too-large" };
        stoppedEarly = true;
        break;
      }
      events.push(event);
      pageBytes += arraySeparatorBytes + encodedBytes;
      expected += 1;
    }
    const sequence = events.at(-1)?.sequence ?? start;
    if (!sawRow && start < last) return { status: "snapshot-required", reason: "event-gap" };
    if (!stoppedEarly && sequence !== last) return { status: "snapshot-required", reason: "event-gap" };
    return {
      status: "events",
      events,
      cursor: { scopeKey: key, sequence },
      hasMore: sequence < last,
    };
  }

  readSnapshot(
    scope: HostChatRecoveryScope,
    authorize: HostChatRecoverySnapshotAuthorization,
  ): HostChatRecoverySnapshot {
    validateScope(scope);
    const db = this.#core.connection;
    if (db.isTransaction) throw new HostChatRecoveryError({ code: "TRANSACTION_ACTIVE" });
    db.exec("BEGIN");
    try {
      if (!authorize(scope)) throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
      const key = scopeKeyFor(scope);
      const lastRow = databaseRow(
        db.prepare("SELECT last_sequence FROM host_chat_recovery_scopes WHERE scope_key = ?").get(key),
      );
      const last = lastRow ? requiredNumberColumn(lastRow, "last_sequence") : 0;
      const targets = db
        .prepare(
          `SELECT DISTINCT agent_id, thread_id FROM host_chat_recovery_messages
           WHERE scope_key = ? ORDER BY agent_id, thread_id`,
        )
        .iterate(key);
      for (const value of targets) {
        const row = databaseRow(value);
        if (!row) throw new HostChatRecoveryError({ code: "SNAPSHOT_INTEGRITY_FAILURE" });
        if (
          !authorize(scope, {
            agentId: requiredStringColumn(row, "agent_id"),
            threadId: requiredStringColumn(row, "thread_id"),
          })
        )
          throw new HostChatRecoveryError({ code: "UNAUTHORIZED" });
      }

      const acceptedRequests: HostChatRecoverySnapshotRequest[] = [];
      let sequence = 0;
      let encodedBytes = Buffer.byteLength(
        JSON.stringify({
          type: "host-chat-inbox-snapshot",
          complete: true,
          acceptedRequests: [],
          cursor: { scopeKey: key, sequence: last },
        }),
        "utf8",
      );
      const requests = db
        .prepare(
          `SELECT event_sequence, message_id, request_id, agent_id, thread_id, content, accepted_at
           FROM host_chat_recovery_messages WHERE scope_key = ? ORDER BY event_sequence`,
        )
        .iterate(key);
      for (const value of requests) {
        const row = databaseRow(value);
        if (!row) throw new HostChatRecoveryError({ code: "SNAPSHOT_INTEGRITY_FAILURE" });
        const request: HostChatRecoverySnapshotRequest = {
          sequence: requiredNumberColumn(row, "event_sequence"),
          messageId: requiredStringColumn(row, "message_id"),
          requestId: requiredStringColumn(row, "request_id"),
          target: {
            agentId: requiredStringColumn(row, "agent_id"),
            threadId: requiredStringColumn(row, "thread_id"),
          },
          content: requiredStringColumn(row, "content"),
          acceptedAt: requiredStringColumn(row, "accepted_at"),
        };
        sequence += 1;
        if (request.sequence !== sequence) throw new HostChatRecoveryError({ code: "SNAPSHOT_INTEGRITY_FAILURE" });
        if (acceptedRequests.length >= MAX_SNAPSHOT_REQUESTS)
          throw new HostChatRecoveryError({ code: "SNAPSHOT_CAPACITY_EXCEEDED" });
        encodedBytes += Buffer.byteLength(JSON.stringify(request), "utf8") + (acceptedRequests.length > 0 ? 1 : 0);
        if (encodedBytes > MAX_SNAPSHOT_BYTES) throw new HostChatRecoveryError({ code: "SNAPSHOT_CAPACITY_EXCEEDED" });
        acceptedRequests.push(request);
      }
      if (sequence !== last) throw new HostChatRecoveryError({ code: "SNAPSHOT_INTEGRITY_FAILURE" });
      const snapshot: HostChatRecoverySnapshot = {
        type: "host-chat-inbox-snapshot",
        complete: true,
        acceptedRequests,
        cursor: { scopeKey: key, sequence: last },
      };
      if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES)
        throw new HostChatRecoveryError({ code: "SNAPSHOT_CAPACITY_EXCEEDED" });
      db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}

function validateInput(input: RecordDurableChatRequestInput): void {
  if (
    !input.requestId ||
    input.requestId.length > 128 ||
    !input.target.agentId ||
    input.target.agentId.length > 256 ||
    !input.target.threadId ||
    input.target.threadId.length > 256 ||
    typeof input.content !== "string" ||
    Buffer.byteLength(input.content, "utf8") > 786_432
  )
    throw new HostChatRecoveryError({ code: "INVALID_INPUT" });
}

function validateScope(scope: HostChatRecoveryScope): void {
  if (
    typeof scope !== "object" ||
    scope === null ||
    typeof scope.hostId !== "string" ||
    typeof scope.userId !== "string" ||
    typeof scope.deviceId !== "string" ||
    typeof scope.grantId !== "string" ||
    scope.capability !== "chat" ||
    scope.hostId.length === 0 ||
    scope.hostId.length > 256 ||
    scope.userId.length === 0 ||
    scope.userId.length > 256 ||
    scope.deviceId.length === 0 ||
    scope.deviceId.length > 256 ||
    scope.grantId.length === 0 ||
    scope.grantId.length > 256 ||
    !Number.isSafeInteger(scope.hostEpoch) ||
    scope.hostEpoch < 0 ||
    !Number.isSafeInteger(scope.authEpoch) ||
    scope.authEpoch < 0 ||
    !Number.isSafeInteger(scope.grantEpoch) ||
    scope.grantEpoch < 0
  )
    throw new HostChatRecoveryError({ code: "INVALID_INPUT" });
}

function canonicalScope(scope: HostChatRecoveryScope): string {
  return JSON.stringify([
    scope.hostId,
    scope.userId,
    scope.deviceId,
    scope.grantId,
    scope.capability,
    scope.hostEpoch,
    scope.authEpoch,
    scope.grantEpoch,
  ]);
}

function scopeKeyFor(scope: HostChatRecoveryScope): string {
  return hash(canonicalScope(scope));
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readReceipt(value: unknown): {
  requestId: string;
  messageId: string;
  requestHash: string;
  eventSequence: number;
  acceptedAt: string;
} | null {
  const row = databaseRow(value);
  if (!row) return null;
  return {
    requestId: requiredStringColumn(row, "request_id"),
    messageId: requiredStringColumn(row, "message_id"),
    requestHash: requiredStringColumn(row, "request_hash"),
    eventSequence: requiredNumberColumn(row, "event_sequence"),
    acceptedAt: requiredStringColumn(row, "accepted_at"),
  };
}
