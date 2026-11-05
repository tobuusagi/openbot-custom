import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  MessageRecoveryCursor,
  MessageRecoveryScope,
  MessageRecoveryStore,
} from "@openbot/team-client/message-recovery";
import { Schema } from "effect";

const DATABASE_NAME = "message-recovery-v1.sqlite";
const APPLICATION_ID = 0x4f425243; // OBRC
const SCHEMA_VERSION = 1;
const InboxSnapshotSchema = Schema.Struct({
  type: Schema.Literal("host-chat-inbox-snapshot"),
  complete: Schema.Literal(true),
  acceptedRequests: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      messageId: Schema.String,
      requestId: Schema.String,
      target: Schema.Struct({ agentId: Schema.String, threadId: Schema.String }),
      content: Schema.String,
      acceptedAt: Schema.String,
    }),
  ),
  cursor: Schema.Struct({ scopeKey: Schema.String, sequence: Schema.Number }),
});

interface StoredSnapshot {
  type: "host-chat-inbox-snapshot";
  complete: true;
  acceptedRequests: ReadonlyArray<{
    sequence: number;
    messageId: string;
    requestId: string;
    target: { agentId: string; threadId: string };
    content: string;
    acceptedAt: string;
  }>;
  cursor: MessageRecoveryCursor;
}

function rowString(
  row: Record<string, string | number | bigint | Uint8Array | null> | undefined,
  column: string,
): string | undefined {
  const value = row?.[column];
  return typeof value === "string" ? value : undefined;
}

function rowNumber(
  row: Record<string, string | number | bigint | Uint8Array | null> | undefined,
  column: string,
): number | undefined {
  const value = row?.[column];
  return typeof value === "number" ? value : undefined;
}

function validateSchema(db: DatabaseSync): void {
  const expected: Record<string, ReadonlyArray<readonly [string, string, number]>> = {
    pending_chat: [
      ["scope_key", "TEXT", 1],
      ["request_id", "TEXT", 2],
      ["body_json", "TEXT", 0],
    ],
    durable_receipt: [
      ["scope_key", "TEXT", 1],
      ["request_id", "TEXT", 2],
      ["request_json", "TEXT", 0],
      ["receipt_json", "TEXT", 0],
    ],
    recovered_event: [
      ["scope_key", "TEXT", 1],
      ["sequence", "INTEGER", 2],
      ["message_id", "TEXT", 0],
      ["body_json", "TEXT", 0],
    ],
    inbox_snapshot: [
      ["scope_key", "TEXT", 1],
      ["sequence", "INTEGER", 2],
      ["message_id", "TEXT", 0],
      ["body_json", "TEXT", 0],
    ],
    recovery_cursor: [
      ["scope_key", "TEXT", 1],
      ["host_scope_key", "TEXT", 0],
      ["sequence", "INTEGER", 0],
    ],
  };
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const names = tables.map((row) => rowString(row, "name"));
  if (names.length !== Object.keys(expected).length || names.some((name) => !name || !(name in expected))) {
    throw new Error("The client recovery database has an unknown schema.");
  }
  const otherObjects =
    rowNumber(
      db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type IN ('trigger','view')").get(),
      "count",
    ) ?? 0;
  if (otherObjects !== 0) throw new Error("The client recovery database contains unknown objects.");
  for (const [table, columns] of Object.entries(expected)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all();
    if (actual.length !== columns.length) throw new Error("The client recovery database has unknown columns.");
    for (let index = 0; index < columns.length; index += 1) {
      const wanted = columns[index];
      const found = actual[index];
      if (
        !wanted ||
        !found ||
        rowString(found, "name") !== wanted[0] ||
        rowString(found, "type") !== wanted[1] ||
        rowNumber(found, "pk") !== wanted[2]
      ) {
        throw new Error("The client recovery database has an incompatible schema.");
      }
    }
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
    const uniqueKeys: string[] = [];
    for (const index of indexes) {
      if (rowNumber(index, "unique") !== 1) continue;
      const name = rowString(index, "name");
      if (!name || !/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("The client recovery database has an unknown key.");
      const keyColumns = db
        .prepare(`PRAGMA index_info('${name}')`)
        .all()
        .map((column) => rowString(column, "name"));
      uniqueKeys.push(keyColumns.join(","));
    }
    const primaryKey = columns
      .filter((column) => column[2] > 0)
      .sort((left, right) => left[2] - right[2])
      .map((column) => column[0])
      .join(",");
    const requiredKeys =
      table === "recovered_event" || table === "inbox_snapshot" ? [primaryKey, "scope_key,message_id"] : [primaryKey];
    if (
      indexes.length !== requiredKeys.length ||
      uniqueKeys.length !== requiredKeys.length ||
      requiredKeys.some((key) => !uniqueKeys.includes(key))
    ) {
      throw new Error("The client recovery database has unknown or missing keys.");
    }
  }
}

/** Stable storage key for every authorization dimension. Never use a host supplied cursor as a key. */
export function clientRecoveryScopeKey(scope: MessageRecoveryScope): string {
  const canonical = JSON.stringify([
    scope.hostId,
    scope.userId,
    scope.deviceId,
    scope.grantId,
    scope.capability,
    scope.hostEpoch,
    scope.authEpoch,
    scope.grantEpoch,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Message recovery operation cancelled.");
}

/**
 * Opens a private SQLite database below the caller's dedicated desktop client profile directory.
 * This module never receives or opens the application database or a Host database.
 */
export async function createClientRecoveryStore(
  clientProfileDir: string,
): Promise<MessageRecoveryStore & { close(): void }> {
  if (!clientProfileDir.trim()) throw new Error("A client profile directory is required.");
  await mkdir(clientProfileDir, { recursive: true, mode: 0o700 });
  const profileStat = await lstat(clientProfileDir);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink())
    throw new Error("The client profile path must be a real directory.");
  await chmod(clientProfileDir, 0o700);
  const path = join(clientProfileDir, DATABASE_NAME);
  let databaseStat: Stats | undefined;
  try {
    databaseStat = await lstat(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    databaseStat = await lstat(path);
  }
  if (databaseStat && (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.nlink !== 1)) {
    throw new Error("The client recovery database must be a private regular file.");
  }
  const db = new DatabaseSync(path);
  try {
    const appId = rowNumber(db.prepare("PRAGMA application_id").get(), "application_id") ?? 0;
    const version = rowNumber(db.prepare("PRAGMA user_version").get(), "user_version") ?? 0;
    const objectCount =
      rowNumber(
        db
          .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type IN ('table','index','trigger','view')")
          .get(),
        "count",
      ) ?? 0;
    if (appId !== 0 && appId !== APPLICATION_ID)
      throw new Error("The client recovery database belongs to another application.");
    if (version > SCHEMA_VERSION)
      throw new Error("The client recovery database schema is newer than this application.");
    if (version > 0 && appId !== APPLICATION_ID) throw new Error("The client recovery database identity is invalid.");
    if (version === 0 && objectCount !== 0)
      throw new Error("Refusing to modify an unrecognized client recovery database.");
    if (version === SCHEMA_VERSION) validateSchema(db);
    if (version === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE pending_chat (
            scope_key TEXT NOT NULL,
            request_id TEXT NOT NULL,
            body_json TEXT NOT NULL,
            PRIMARY KEY (scope_key, request_id)
          ) WITHOUT ROWID;
          CREATE TABLE durable_receipt (
            scope_key TEXT NOT NULL,
            request_id TEXT NOT NULL,
            request_json TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            PRIMARY KEY (scope_key, request_id)
          ) WITHOUT ROWID;
          CREATE TABLE recovered_event (
            scope_key TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            body_json TEXT NOT NULL,
            PRIMARY KEY (scope_key, sequence),
            UNIQUE (scope_key, message_id)
          ) WITHOUT ROWID;
          CREATE TABLE inbox_snapshot (
            scope_key TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            body_json TEXT NOT NULL,
            PRIMARY KEY (scope_key, sequence),
            UNIQUE (scope_key, message_id)
          ) WITHOUT ROWID;
          CREATE TABLE recovery_cursor (
            scope_key TEXT PRIMARY KEY,
            host_scope_key TEXT NOT NULL,
            sequence INTEGER NOT NULL
          ) WITHOUT ROWID;
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction may already be rolled back */
        }
        throw error;
      }
    }
    await chmod(path, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;
  const connection = () => {
    if (closed) throw new Error("The client recovery store is closed.");
    return db;
  };
  const scopeKey = clientRecoveryScopeKey;
  const transaction = <A>(signal: AbortSignal, write: (database: DatabaseSync) => A): A => {
    const database = connection();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = write(database);
      abortIfNeeded(signal);
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        /* SQLite may have rolled back after an I/O error */
      }
      throw error;
    }
  };

  const store: MessageRecoveryStore & { close(): void } = {
    async enqueuePendingChat(scope, request, signal) {
      transaction(signal, (database) => {
        const key = scopeKey(scope);
        const encoded = json(request);
        const existing = rowString(
          database
            .prepare("SELECT body_json FROM pending_chat WHERE scope_key=? AND request_id=?")
            .get(key, request.requestId),
          "body_json",
        );
        const acknowledged = rowString(
          database
            .prepare("SELECT request_json FROM durable_receipt WHERE scope_key=? AND request_id=?")
            .get(key, request.requestId),
          "request_json",
        );
        if (acknowledged && acknowledged !== encoded)
          throw new Error("Acknowledged request id conflicts with stored content.");
        if (existing && existing !== encoded) throw new Error("Pending request id conflicts with stored content.");
        if (acknowledged) return;
        database
          .prepare("INSERT OR IGNORE INTO pending_chat(scope_key,request_id,body_json) VALUES(?,?,?)")
          .run(key, request.requestId, encoded);
      });
    },
    async listPendingChats(scope, signal) {
      abortIfNeeded(signal);
      const rows = connection()
        .prepare("SELECT body_json FROM pending_chat WHERE scope_key=? ORDER BY request_id")
        .all(scopeKey(scope));
      abortIfNeeded(signal);
      return rows.map((row) => {
        const body = rowString(row, "body_json");
        if (body === undefined) throw new Error("Pending request row is invalid.");
        return JSON.parse(body);
      });
    },
    async acknowledgePendingChat(scope, requestId, receipt, signal) {
      transaction(signal, (database) => {
        const key = scopeKey(scope);
        if (
          receipt.requestId !== requestId ||
          !receipt.receiptId ||
          !receipt.messageId ||
          !Number.isSafeInteger(receipt.eventSequence) ||
          receipt.eventSequence < 1 ||
          !Number.isFinite(Date.parse(receipt.acceptedAt))
        )
          throw new Error("Durable receipt does not match a valid Host acceptance.");
        const pending = rowString(
          database.prepare("SELECT body_json FROM pending_chat WHERE scope_key=? AND request_id=?").get(key, requestId),
          "body_json",
        );
        const oldRequest = rowString(
          database
            .prepare("SELECT request_json FROM durable_receipt WHERE scope_key=? AND request_id=?")
            .get(key, requestId),
          "request_json",
        );
        const oldReceipt = rowString(
          database
            .prepare("SELECT receipt_json FROM durable_receipt WHERE scope_key=? AND request_id=?")
            .get(key, requestId),
          "receipt_json",
        );
        const encoded = json(receipt);
        if (oldReceipt) {
          if (oldReceipt !== encoded || !oldRequest)
            throw new Error("Durable receipt conflicts with the stored receipt.");
          return;
        }
        if (!pending) throw new Error("No matching pending request exists for this receipt.");
        database
          .prepare("INSERT INTO durable_receipt(scope_key,request_id,request_json,receipt_json) VALUES(?,?,?,?)")
          .run(key, requestId, pending, encoded);
        database.prepare("DELETE FROM pending_chat WHERE scope_key=? AND request_id=?").run(key, requestId);
      });
    },
    async readCursor(scope, signal) {
      abortIfNeeded(signal);
      const row = connection()
        .prepare("SELECT host_scope_key, sequence FROM recovery_cursor WHERE scope_key=?")
        .get(scopeKey(scope));
      abortIfNeeded(signal);
      const hostScopeKey = rowString(row, "host_scope_key");
      const sequence = rowNumber(row, "sequence");
      return hostScopeKey !== undefined && sequence !== undefined ? { scopeKey: hostScopeKey, sequence } : undefined;
    },
    async storeEvent(scope, event, signal) {
      transaction(signal, (database) => {
        const key = scopeKey(scope);
        const encoded = json(event);
        const byMessage = rowString(
          database
            .prepare("SELECT body_json FROM recovered_event WHERE scope_key=? AND message_id=?")
            .get(key, event.messageId),
          "body_json",
        );
        const bySequence = rowString(
          database
            .prepare("SELECT body_json FROM recovered_event WHERE scope_key=? AND sequence=?")
            .get(key, event.sequence),
          "body_json",
        );
        if ((byMessage && byMessage !== encoded) || (bySequence && bySequence !== encoded)) {
          throw new Error("Recovered event conflicts with stored content.");
        }
        database
          .prepare("INSERT OR IGNORE INTO recovered_event(scope_key,sequence,message_id,body_json) VALUES(?,?,?,?)")
          .run(key, event.sequence, event.messageId, encoded);
      });
    },
    async advanceCursor(scope, cursor, signal) {
      transaction(signal, (database) => {
        const key = scopeKey(scope);
        const current = database
          .prepare("SELECT host_scope_key, sequence FROM recovery_cursor WHERE scope_key=?")
          .get(key);
        const currentScopeKey = rowString(current, "host_scope_key");
        const currentValue = rowNumber(current, "sequence");
        if (cursor.scopeKey !== scopeKey(scope))
          throw new Error("Recovery cursor does not match this authorization scope.");
        if (currentScopeKey !== undefined && currentScopeKey !== cursor.scopeKey)
          throw new Error("Recovery cursor scope changed without a snapshot.");
        const currentSequence = currentValue ?? 0;
        if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0)
          throw new Error("Recovery cursor sequence is invalid.");
        if (cursor.sequence < currentSequence) throw new Error("Recovery cursor cannot move backwards.");
        if (cursor.sequence > currentSequence) {
          const count =
            rowNumber(
              database
                .prepare(
                  "SELECT count(*) AS count FROM recovered_event WHERE scope_key=? AND sequence>? AND sequence<=?",
                )
                .get(key, currentSequence, cursor.sequence),
              "count",
            ) ?? 0;
          if (count !== cursor.sequence - currentSequence)
            throw new Error("Recovery cursor cannot cross a missing event.");
        }
        database
          .prepare(
            "INSERT INTO recovery_cursor(scope_key,host_scope_key,sequence) VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET sequence=excluded.sequence",
          )
          .run(key, cursor.scopeKey, cursor.sequence);
      });
    },
    async replaceSnapshotAndCursor(scope, body, cursor, signal) {
      const snapshot = Schema.decodeUnknownSync(InboxSnapshotSchema)(body) satisfies StoredSnapshot;
      if (
        !Number.isSafeInteger(cursor.sequence) ||
        cursor.sequence < 0 ||
        cursor.scopeKey !== scopeKey(scope) ||
        snapshot.cursor.sequence !== cursor.sequence ||
        snapshot.cursor.scopeKey !== cursor.scopeKey
      )
        throw new Error("Snapshot cursor does not match this authorization scope.");
      if (snapshot.acceptedRequests.length > 500 || Buffer.byteLength(json(snapshot), "utf8") > 1_048_576)
        throw new Error("Host inbox snapshot exceeds storage limits.");
      for (let index = 0; index < snapshot.acceptedRequests.length; index += 1) {
        const request = snapshot.acceptedRequests[index];
        if (
          !request ||
          request.sequence !== index + 1 ||
          !request.messageId ||
          !request.requestId ||
          !request.target.agentId ||
          !request.target.threadId ||
          Buffer.byteLength(request.content, "utf8") > 786_432 ||
          !Number.isFinite(Date.parse(request.acceptedAt))
        )
          throw new Error("Host inbox snapshot is invalid or incomplete.");
      }
      if ((snapshot.acceptedRequests.at(-1)?.sequence ?? 0) !== cursor.sequence)
        throw new Error("Host inbox snapshot cursor has no matching complete history.");
      transaction(signal, (database) => {
        const key = scopeKey(scope);
        database.prepare("DELETE FROM recovered_event WHERE scope_key=?").run(key);
        database.prepare("DELETE FROM inbox_snapshot WHERE scope_key=?").run(key);
        const insert = database.prepare(
          "INSERT INTO inbox_snapshot(scope_key,sequence,message_id,body_json) VALUES(?,?,?,?)",
        );
        for (const request of snapshot.acceptedRequests)
          insert.run(key, request.sequence, request.messageId, json(request));
        database
          .prepare(
            "INSERT INTO recovery_cursor(scope_key,host_scope_key,sequence) VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET host_scope_key=excluded.host_scope_key,sequence=excluded.sequence",
          )
          .run(key, cursor.scopeKey, cursor.sequence);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
  return store;
}
