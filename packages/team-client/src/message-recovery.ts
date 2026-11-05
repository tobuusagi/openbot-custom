import { Effect, Result, Schema } from "effect";
import { runTeamEffect } from "./effect-boundary";

/** The cursor and outbox key includes every authorization dimension from 011. */
export const MessageRecoveryScope = Schema.Struct({
  hostId: Schema.String,
  userId: Schema.String,
  deviceId: Schema.String,
  grantId: Schema.String,
  capability: Schema.Literal("chat"),
  hostEpoch: Schema.Number,
  authEpoch: Schema.Number,
  grantEpoch: Schema.Number,
});
export type MessageRecoveryScope = typeof MessageRecoveryScope.Type;

const ChatTarget = Schema.Struct({ agentId: Schema.String, threadId: Schema.String });
export type ChatTarget = typeof ChatTarget.Type;

const PendingChat = Schema.Struct({
  requestId: Schema.String,
  target: ChatTarget,
  content: Schema.String,
});
export type PendingChat = typeof PendingChat.Type;

export const MessageRecoveryCursor = Schema.Struct({ scopeKey: Schema.String, sequence: Schema.Number });
export type MessageRecoveryCursor = typeof MessageRecoveryCursor.Type;

/** A receipt returned only after the Host committed the chat request to its durable store. */
export const DurableChatReceipt = Schema.Struct({
  receiptId: Schema.String,
  requestId: Schema.String,
  messageId: Schema.String,
  eventSequence: Schema.Number,
  acceptedAt: Schema.String,
});
export type DurableChatReceipt = typeof DurableChatReceipt.Type;

export const RecoveredChatEvent = Schema.Struct({
  sequence: Schema.Number,
  messageId: Schema.String,
  requestId: Schema.String,
  target: ChatTarget,
  content: Schema.String,
  occurredAt: Schema.String,
});
export type RecoveredChatEvent = typeof RecoveredChatEvent.Type;

const EventBatch = Schema.Struct({
  status: Schema.Literal("events"),
  events: Schema.Array(Schema.Unknown),
  cursor: MessageRecoveryCursor,
  hasMore: Schema.Boolean,
});
const SnapshotRequired = Schema.Struct({
  status: Schema.Literal("snapshot-required"),
  reason: Schema.Literals(["scope-changed", "cursor-ahead", "event-gap", "authorization-changed", "event-too-large"]),
});
const ChatInboxSnapshot = Schema.Struct({
  type: Schema.Literal("host-chat-inbox-snapshot"),
  complete: Schema.Literal(true),
  acceptedRequests: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      messageId: Schema.String,
      requestId: Schema.String,
      target: ChatTarget,
      content: Schema.String,
      acceptedAt: Schema.String,
    }),
  ),
  cursor: MessageRecoveryCursor,
});
export type ChatInboxSnapshot = typeof ChatInboxSnapshot.Type;

/**
 * Platform-owned durable storage. Implementations must commit each method atomically and must
 * check AbortSignal immediately before commit. Event insertion must be idempotent by messageId
 * and reject a conflicting event at the same messageId or sequence.
 * replaceSnapshotAndCursor must replace both values in one durable transaction.
 */
export interface MessageRecoveryStore {
  enqueuePendingChat(scope: MessageRecoveryScope, request: PendingChat, signal: AbortSignal): Promise<void>;
  listPendingChats(scope: MessageRecoveryScope, signal: AbortSignal): Promise<ReadonlyArray<unknown>>;
  acknowledgePendingChat(
    scope: MessageRecoveryScope,
    requestId: string,
    receipt: DurableChatReceipt,
    signal: AbortSignal,
  ): Promise<void>;
  readCursor(scope: MessageRecoveryScope, signal: AbortSignal): Promise<MessageRecoveryCursor | undefined>;
  storeEvent(scope: MessageRecoveryScope, event: RecoveredChatEvent, signal: AbortSignal): Promise<void>;
  advanceCursor(scope: MessageRecoveryScope, cursor: MessageRecoveryCursor, signal: AbortSignal): Promise<void>;
  replaceSnapshotAndCursor(
    scope: MessageRecoveryScope,
    body: unknown,
    cursor: MessageRecoveryCursor,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * sendChat must call the Host's durable inbox receipt operation. A WebSocket, WebRTC, or gateway
 * ACK is not a DurableChatReceipt and cannot clear the outbox entry. The receipt means durable
 * acceptance only; it does not mean that a provider or conversation consumer processed the chat.
 */
export interface MessageRecoveryTransport {
  /** The Host adapter must derive or verify scope from its authenticated session, not trust this value. */
  recordDurableChatRequest(
    input: { scope: MessageRecoveryScope; target: ChatTarget; requestId: string; content: string },
    signal: AbortSignal,
  ): Promise<unknown>;
  readEvents(
    scope: MessageRecoveryScope,
    afterCursor: MessageRecoveryCursor | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
  readChatInboxSnapshot(scope: MessageRecoveryScope, signal: AbortSignal): Promise<unknown>;
}

export class MessageRecoveryError extends Schema.TaggedError<MessageRecoveryError>()("MessageRecoveryError", {
  code: Schema.Literals([
    "scope-invalid",
    "response-invalid",
    "cursor-gap",
    "cancelled",
    "operation-failed",
    "transport-temporary",
    "transport-permanent",
  ]),
}) {}

const isCursor = (value: MessageRecoveryCursor): boolean =>
  value.scopeKey.length > 0 && Number.isSafeInteger(value.sequence) && value.sequence >= 0;
const validRequestId = (value: string): boolean => value.length > 0 && value.length <= 128;
const validTargetId = (value: string): boolean => value.length > 0 && value.length <= 256;
const validStoredId = (value: string): boolean => value.length > 0 && value.length <= 256;
const validScopeId = (value: string): boolean => value.length > 0;
const validEpoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const RECOVERY_PAGE_LIMIT = 4;
const HOST_EVENT_PAGE_LIMIT = 100;
const HOST_EVENT_PAGE_BYTES = 1_048_576;
function utf8ByteLength(value: string): number {
  let length: number = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], MessageRecoveryError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new MessageRecoveryError({ code: "response-invalid" })),
  );
}

function io<A>(operation: () => Promise<A>): Effect.Effect<A, MessageRecoveryError> {
  return Effect.tryPromise({
    try: operation,
    catch: () => new MessageRecoveryError({ code: "operation-failed" }),
  });
}

export type MessageRecoveryFailureClass = "temporary" | "permanent" | "cancelled";

/** Classify only the stable local error code. Never inspect remote error text or payload content. */
export function classifyMessageRecoveryFailure(error: unknown): MessageRecoveryFailureClass {
  if (!(error instanceof MessageRecoveryError)) return "temporary";
  if (error.code === "transport-permanent") return "permanent";
  if (error.code === "cancelled") return "cancelled";
  return "temporary";
}

/**
 * Opt-in portable chat recovery core. It has no platform storage or transport implementation.
 * This release provides receipt/outbox and cursor single-flight behavior plus a separately
 * opt-in recovery scheduler. It does not wire desktop, mobile, or web transports. Snapshots contain
 * durable inbox acceptances only; they do not describe conversation or Provider processing.
 */
export function createMessageRecoveryController(options: {
  scope: MessageRecoveryScope;
  store: MessageRecoveryStore;
  transport: MessageRecoveryTransport;
  createRequestId: () => string;
  /** Trusted adapter classification for transport/auth errors; peer text is not a classification source. */
  classifyTransportFailure(error: unknown): MessageRecoveryFailureClass;
}) {
  const checkedScope = Schema.decodeUnknownSync(MessageRecoveryScope)(options.scope);
  if (
    !validEpoch(checkedScope.hostEpoch) ||
    !validEpoch(checkedScope.authEpoch) ||
    !validEpoch(checkedScope.grantEpoch) ||
    ![checkedScope.hostId, checkedScope.userId, checkedScope.deviceId, checkedScope.grantId].every(validScopeId)
  ) {
    throw new MessageRecoveryError({ code: "scope-invalid" });
  }

  let generation = 0;
  let disposed = false;
  const activeAbort = new AbortController();
  let flushFlight: Promise<void> | undefined;
  let recoverFlight: Promise<boolean> | undefined;
  let flushDirty = false;

  const current = (token: number, signal: AbortSignal) => {
    if (disposed || generation !== token || signal.aborted) {
      throw new MessageRecoveryError({ code: "cancelled" });
    }
  };

  function cancel() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    activeAbort.abort();
  }

  const transportIo = <A>(operation: () => Promise<A>): Effect.Effect<A, MessageRecoveryError> =>
    Effect.tryPromise({
      try: operation,
      catch: (error) => {
        const failure = options.classifyTransportFailure(error);
        return new MessageRecoveryError({
          code:
            failure === "permanent"
              ? "transport-permanent"
              : failure === "cancelled"
                ? "cancelled"
                : "transport-temporary",
        });
      },
    });

  const sendChat = Effect.fn("MessageRecovery.sendChat")(function* (target: ChatTarget, content: string) {
    if (disposed) return yield* Effect.fail(new MessageRecoveryError({ code: "cancelled" }));
    const requestId = options.createRequestId();
    if (!validRequestId(requestId)) return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
    const pending = yield* decode(PendingChat, { requestId, target, content });
    if (
      !validTargetId(pending.target.agentId) ||
      !validTargetId(pending.target.threadId) ||
      utf8ByteLength(pending.content) > 786_432
    ) {
      return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
    }
    const token = generation;
    const signal = activeAbort.signal;
    yield* io(() => options.store.enqueuePendingChat(checkedScope, pending, signal));
    current(token, signal);
    yield* io(() => flushOutbox());
    current(token, signal);
    return requestId;
  });

  const flushOutboxEffect = Effect.fn("MessageRecovery.flushOutbox")(function* () {
    if (disposed) return yield* Effect.fail(new MessageRecoveryError({ code: "cancelled" }));
    const token = generation;
    const signal = activeAbort.signal;
    const entries = yield* io(() => options.store.listPendingChats(checkedScope, signal));
    current(token, signal);
    for (const value of entries) {
      const request = yield* decode(PendingChat, value);
      if (
        !validRequestId(request.requestId) ||
        !validTargetId(request.target.agentId) ||
        !validTargetId(request.target.threadId) ||
        utf8ByteLength(request.content) > 786_432
      )
        return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
      const rawReceipt = yield* transportIo(() =>
        options.transport.recordDurableChatRequest({ scope: checkedScope, ...request }, signal),
      );
      current(token, signal);
      const receipt = yield* decode(DurableChatReceipt, rawReceipt);
      if (
        !validStoredId(receipt.receiptId) ||
        !validRequestId(receipt.requestId) ||
        !validStoredId(receipt.messageId) ||
        receipt.requestId !== request.requestId ||
        !Number.isSafeInteger(receipt.eventSequence) ||
        receipt.eventSequence < 1 ||
        receipt.acceptedAt.length === 0 ||
        !Number.isFinite(Date.parse(receipt.acceptedAt))
      ) {
        return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
      }
      current(token, signal);
      // This is the only operation that can remove an outbox item. Transport ACKs are ignored.
      yield* io(() => options.store.acknowledgePendingChat(checkedScope, request.requestId, receipt, signal));
      current(token, signal);
    }
  });

  const recoverEffect = Effect.fn("MessageRecovery.recover")(function* () {
    if (disposed) return yield* Effect.fail(new MessageRecoveryError({ code: "cancelled" }));
    const token = generation;
    const signal = activeAbort.signal;
    let cursor = yield* io(() => options.store.readCursor(checkedScope, signal));
    current(token, signal);
    if (cursor !== undefined && !isCursor(cursor)) {
      return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
    }
    const installSnapshot = Effect.fn("MessageRecovery.installSnapshot")(function* () {
      const rawSnapshot = yield* transportIo(() => options.transport.readChatInboxSnapshot(checkedScope, signal));
      current(token, signal);
      const snapshot = yield* decode(ChatInboxSnapshot, rawSnapshot);
      if (
        !isCursor(snapshot.cursor) ||
        snapshot.acceptedRequests.length > 500 ||
        utf8ByteLength(JSON.stringify(snapshot)) > HOST_EVENT_PAGE_BYTES
      )
        return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
      let expected = 1;
      for (const request of snapshot.acceptedRequests) {
        if (
          request.sequence !== expected ||
          !validStoredId(request.messageId) ||
          !validRequestId(request.requestId) ||
          !validTargetId(request.target.agentId) ||
          !validTargetId(request.target.threadId) ||
          utf8ByteLength(request.content) > 786_432 ||
          request.acceptedAt.length === 0 ||
          !Number.isFinite(Date.parse(request.acceptedAt))
        )
          return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
        expected += 1;
      }
      if ((snapshot.acceptedRequests.at(-1)?.sequence ?? 0) !== snapshot.cursor.sequence) {
        return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
      }
      yield* io(() => options.store.replaceSnapshotAndCursor(checkedScope, snapshot, snapshot.cursor, signal));
      current(token, signal);
    });
    for (let page = 0; page < RECOVERY_PAGE_LIMIT; page += 1) {
      current(token, signal);
      const response = yield* transportIo(() => options.transport.readEvents(checkedScope, cursor, signal));
      current(token, signal);
      const required = yield* Effect.result(decode(SnapshotRequired, response));
      if (Result.isSuccess(required)) {
        yield* installSnapshot();
        return false;
      }
      const batch = yield* decode(EventBatch, response);
      if (
        !isCursor(batch.cursor) ||
        (cursor && cursor.scopeKey !== batch.cursor.scopeKey) ||
        batch.events.length > HOST_EVENT_PAGE_LIMIT
      ) {
        yield* installSnapshot();
        return false;
      }
      let next = cursor?.sequence ?? 0;
      let pageBytes = 0;
      for (const rawEvent of batch.events) {
        const event = yield* decode(RecoveredChatEvent, rawEvent);
        if (
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 1 ||
          !validStoredId(event.messageId) ||
          !validRequestId(event.requestId) ||
          !validTargetId(event.target.agentId) ||
          !validTargetId(event.target.threadId) ||
          utf8ByteLength(event.content) > 786_432 ||
          event.occurredAt.length === 0 ||
          !Number.isFinite(Date.parse(event.occurredAt))
        ) {
          return yield* Effect.fail(new MessageRecoveryError({ code: "response-invalid" }));
        }
        pageBytes += utf8ByteLength(JSON.stringify(event));
        if (pageBytes > HOST_EVENT_PAGE_BYTES) {
          yield* installSnapshot();
          return false;
        }
        if (event.sequence <= next) {
          // Let durable storage verify that this replay has the same message and sequence content.
          current(token, signal);
          yield* io(() => options.store.storeEvent(checkedScope, event, signal));
          current(token, signal);
          continue;
        }
        if (event.sequence !== next + 1) {
          yield* installSnapshot();
          return false;
        }
        current(token, signal);
        yield* io(() => options.store.storeEvent(checkedScope, event, signal));
        current(token, signal);
        next = event.sequence;
      }
      if (next !== batch.cursor.sequence) {
        yield* installSnapshot();
        return false;
      }
      const previousSequence = cursor?.sequence ?? 0;
      if (!cursor || next > cursor.sequence) {
        // Event data is durable before its cursor. A crash between calls causes safe redelivery.
        yield* io(() => options.store.advanceCursor(checkedScope, batch.cursor, signal));
        current(token, signal);
      }
      cursor = batch.cursor;
      if (!batch.hasMore) return false;
      if (batch.events.length === 0 || batch.cursor.sequence <= previousSequence) {
        return yield* Effect.fail(new MessageRecoveryError({ code: "cursor-gap" }));
      }
    }
    return true;
  });

  function singleFlight<A>(
    operation: () => Promise<A>,
    get: () => Promise<A> | undefined,
    set: (value: Promise<A> | undefined) => void,
  ): Promise<A> {
    const existing = get();
    if (existing) return existing;
    const run = operation().finally(() => {
      if (get() === run) set(undefined);
    });
    set(run);
    return run;
  }

  function flushOutbox(): Promise<void> {
    flushDirty = true;
    if (flushFlight) {
      return flushFlight.then(() => (flushDirty ? flushOutbox() : undefined));
    }
    const run = async () => {
      while (flushDirty) {
        flushDirty = false;
        await runTeamEffect(flushOutboxEffect(), activeAbort.signal);
      }
    };
    const flight = run().finally(() => {
      if (flushFlight === flight) flushFlight = undefined;
    });
    flushFlight = flight;
    return flight;
  }

  return {
    sendChat: (target: ChatTarget, content: string) => runTeamEffect(sendChat(target, content), activeAbort.signal),
    flushOutbox,
    recover: () =>
      singleFlight(
        () => runTeamEffect(recoverEffect(), activeAbort.signal),
        () => recoverFlight,
        (value) => (recoverFlight = value),
      ),
    /** Logout, revoke, and dispose all invalidate this controller generation and abort pending work. */
    logout: cancel,
    revoke: cancel,
    dispose: cancel,
  };
}

export interface MessageRecoverySchedulerState {
  phase: "idle" | "recovering" | "waiting" | "stopped";
  attempt: number;
  waitMs: number;
  elapsedMs: number;
  alerted: boolean;
  reason?: "permanent" | "cancelled" | "stopped";
}
export interface MessageRecoverySchedulerRuntime {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  jitter(baseMs: number, maxMs: number): number;
}

/** Opt-in retries begin only after an explicit start or resume call. */
export function createMessageRecoveryScheduler(
  controller: ReturnType<typeof createMessageRecoveryController>,
  options: {
    runtime: MessageRecoverySchedulerRuntime;
    /** Map trusted transport/auth errors to policy classes; never infer permanence from peer text. */
    classifyFailure(error: unknown): MessageRecoveryFailureClass;
    onState?(state: MessageRecoverySchedulerState): void;
    onFailure?(failure: MessageRecoveryFailureClass): void;
  },
) {
  const BASE_DELAY_MS = 500;
  const MAX_DELAY_MS = 30_000;
  const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
  let active = false;
  let disposed = false;
  let generation = 0;
  let timer: unknown;
  let timerScheduled = false;
  let running = false;
  let queuedGeneration: number | undefined;
  let attempt = 0;
  let startedAt = 0;
  let alerted = false;

  const emit = (
    phase: MessageRecoverySchedulerState["phase"],
    waitMs = 0,
    reason?: MessageRecoverySchedulerState["reason"],
  ) => {
    options.onState?.({
      phase,
      attempt,
      waitMs,
      elapsedMs: Math.max(0, options.runtime.now() - startedAt),
      alerted,
      ...(reason ? { reason } : {}),
    });
  };
  const clearTimer = () => {
    if (timerScheduled) options.runtime.clearTimeout(timer);
    timerScheduled = false;
    timer = undefined;
  };
  const schedule = (token: number, baseMs: number) => {
    if (!active || disposed || token !== generation || timerScheduled) return;
    const jittered = options.runtime.jitter(baseMs, MAX_DELAY_MS);
    const waitMs = Number.isFinite(jittered) ? Math.max(0, Math.min(MAX_DELAY_MS, Math.floor(jittered))) : baseMs;
    timerScheduled = true;
    timer = options.runtime.setTimeout(() => {
      timerScheduled = false;
      timer = undefined;
      if (active && !disposed && token === generation) void run(token);
    }, waitMs);
    emit("waiting", waitMs);
  };

  const run = async (token: number): Promise<void> => {
    if (!active || disposed || token !== generation) return;
    if (running) {
      queuedGeneration = token;
      return;
    }
    running = true;
    emit("recovering");
    try {
      await controller.flushOutbox();
      if (!active || disposed || token !== generation) return;
      const hasMore = await controller.recover();
      if (!active || disposed || token !== generation) return;
      attempt = 0;
      startedAt = options.runtime.now();
      alerted = false;
      if (hasMore) schedule(token, 0);
      else emit("idle");
    } catch (error) {
      if (!active || disposed || token !== generation) return;
      const failure = options.classifyFailure(error);
      options.onFailure?.(failure);
      if (failure === "cancelled" || failure === "permanent") {
        active = false;
        generation += 1;
        clearTimer();
        emit("stopped", 0, failure);
      } else {
        attempt += 1;
        if (!alerted && options.runtime.now() - startedAt >= ALERT_AFTER_MS) alerted = true;
        const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 16));
        schedule(token, exponential);
      }
    } finally {
      running = false;
      const queued = queuedGeneration;
      queuedGeneration = undefined;
      if (queued !== undefined && active && !disposed && queued === generation) void run(queued);
    }
  };

  const start = () => {
    if (disposed || active) return;
    active = true;
    generation += 1;
    attempt = 0;
    alerted = false;
    startedAt = options.runtime.now();
    void run(generation);
  };
  const resume = () => {
    if (disposed) return;
    if (!active) return start();
    if (running) return;
    if (timerScheduled) clearTimer();
    void run(generation);
  };
  /** Pause retries. An in-flight operation may finish; use logout/revoke/dispose to abort it. */
  const stop = () => {
    if (!active && !timerScheduled) return;
    active = false;
    generation += 1;
    clearTimer();
    emit("stopped", 0, "stopped");
  };
  const logout = () => {
    stop();
    controller.logout();
  };
  const revoke = () => {
    stop();
    controller.revoke();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    controller.dispose();
  };
  return { start, resume, stop, logout, revoke, dispose };
}
