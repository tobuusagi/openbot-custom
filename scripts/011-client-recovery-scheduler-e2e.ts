import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMessageRecoveryFailure,
  createMessageRecoveryController,
  createMessageRecoveryScheduler,
  type MessageRecoveryCursor,
  type MessageRecoverySchedulerState,
  type MessageRecoveryScope,
  type MessageRecoveryStore,
  type MessageRecoveryTransport,
  type RecoveredChatEvent,
} from "@openbot/team-client/message-recovery";
import { runCauseEffect } from "../src/backend/effect-boundary";
import {
  type HostChatRecoveryScope,
  type HostChatRecoveryTarget,
  OpenBotDatabase,
} from "../src/backend/openbot-database";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const scope: MessageRecoveryScope = {
  hostId: "snapshot-host",
  userId: "snapshot-user",
  deviceId: "snapshot-device",
  grantId: "snapshot-grant",
  capability: "chat",
  hostEpoch: 3,
  authEpoch: 5,
  grantEpoch: 7,
};
const target: HostChatRecoveryTarget = { agentId: "snapshot-agent", threadId: "snapshot-thread" };

class Store implements MessageRecoveryStore {
  cursor: MessageRecoveryCursor | undefined;
  snapshot: unknown;
  events = new Map<string, RecoveredChatEvent>();
  async enqueuePendingChat(): Promise<void> {}
  async listPendingChats(): Promise<readonly unknown[]> {
    return [];
  }
  async acknowledgePendingChat(): Promise<void> {}
  async readCursor(): Promise<MessageRecoveryCursor | undefined> {
    return this.cursor;
  }
  async storeEvent(_scope: MessageRecoveryScope, event: RecoveredChatEvent): Promise<void> {
    this.events.set(event.messageId, event);
  }
  async advanceCursor(_scope: MessageRecoveryScope, cursor: MessageRecoveryCursor): Promise<void> {
    this.cursor = cursor;
  }
  async replaceSnapshotAndCursor(
    _scope: MessageRecoveryScope,
    snapshot: unknown,
    cursor: MessageRecoveryCursor,
  ): Promise<void> {
    this.snapshot = snapshot;
    this.events.clear();
    this.cursor = cursor;
  }
}

class FakeRuntime {
  nowMs = 0;
  nextId = 0;
  tasks = new Map<number, { callback: () => void; delayMs: number }>();
  readonly states: MessageRecoverySchedulerState[] = [];
  readonly stateWaiters: Array<(state: MessageRecoverySchedulerState) => void> = [];
  now = () => this.nowMs;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    if (typeof handle === "number") this.tasks.delete(handle);
  };
  jitter = (baseMs: number, maxMs: number) => Math.min(maxMs, baseMs);
  onState = (state: MessageRecoverySchedulerState) => {
    this.states.push(state);
    for (let index = this.stateWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.stateWaiters[index];
      if (waiter) waiter(state);
    }
  };
  waitFor(predicate: (state: MessageRecoverySchedulerState) => boolean): Promise<MessageRecoverySchedulerState> {
    const existing = this.states.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.stateWaiters.push((state) => {
        if (predicate(state)) resolve(state);
      });
    });
  }
  elapse(ms: number): void {
    this.nowMs += ms;
  }
  async fireNext(): Promise<void> {
    const first = this.tasks.entries().next();
    if (first.done) throw new Error("No scheduled recovery timer.");
    const [id, task] = first.value;
    this.tasks.delete(id);
    task.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function isInboxSnapshot(value: unknown): value is {
  type: "host-chat-inbox-snapshot";
  complete: true;
  acceptedRequests: Array<{ sequence: number; content: string }>;
  cursor: MessageRecoveryCursor;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "host-chat-inbox-snapshot" &&
    "complete" in value &&
    value.complete === true &&
    "acceptedRequests" in value &&
    Array.isArray(value.acceptedRequests) &&
    "cursor" in value
  );
}

const tempRoot = await mkdtemp(join(tmpdir(), "openbot-011-client-scheduler-"));
const database = new OpenBotDatabase(join(tempRoot, "state"));
const hostScope: HostChatRecoveryScope = scope;
const report: string[] = [];
let authorized = true;
let disconnected = false;
let permanent = false;
let readCalls = 0;

try {
  await runCauseEffect(database.initialize());
  const authorize = (candidateScope: HostChatRecoveryScope, candidateTarget?: HostChatRecoveryTarget) =>
    authorized &&
    candidateScope.hostId === scope.hostId &&
    candidateScope.userId === scope.userId &&
    (!candidateTarget || (candidateTarget.agentId === target.agentId && candidateTarget.threadId === target.threadId));
  let hostScopeKey = "";
  for (let index = 0; index < 3; index += 1) {
    const receipt = database.recordDurableChatRequest(
      {
        scope: hostScope,
        target,
        requestId: `snapshot-request-${index}`,
        content: `accepted inbox message ${index}`,
      },
      authorize,
    );
    if (index === 0) hostScopeKey = receipt.receiptId.split(":")[0] ?? "";
  }

  const store = new Store();
  // A stale local scope cursor forces the real Host facade to request a snapshot.
  store.cursor = { scopeKey: hostScopeKey, sequence: 99 };
  const transport: MessageRecoveryTransport = {
    async recordDurableChatRequest(input) {
      return database.recordDurableChatRequest(input, authorize);
    },
    async readEvents(candidateScope, afterCursor) {
      readCalls += 1;
      if (disconnected) throw new Error("fixture transport unavailable");
      return database.readDurableChatEvents(candidateScope, afterCursor, authorize);
    },
    async readChatInboxSnapshot(candidateScope) {
      return database.readDurableChatSnapshot(candidateScope, authorize);
    },
  };
  const client = createMessageRecoveryController({
    scope,
    store,
    transport,
    createRequestId: () => "unused-request-id",
    classifyTransportFailure: (error) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "UNAUTHORIZED"
        ? "permanent"
        : "temporary",
  });
  await client.recover();
  assert(store.cursor?.sequence === 3, "snapshot installs the real Host event cursor");
  assert(
    isInboxSnapshot(store.snapshot) &&
      store.snapshot.acceptedRequests.length === 3 &&
      store.snapshot.acceptedRequests[2]?.content === "accepted inbox message 2",
    "snapshot reads only committed Host inbox acceptances",
  );
  report.push("real-host-inbox-snapshot-installed");
  database.recordDurableChatRequest(
    { scope: hostScope, target, requestId: "snapshot-tail", content: "accepted after snapshot" },
    authorize,
  );
  await client.recover();
  assert(
    store.cursor?.sequence === 4 && store.events.size === 1,
    "event recovery resumes after the real inbox snapshot cursor",
  );
  report.push("real-host-event-tail-follows-snapshot");

  const runtime = new FakeRuntime();
  disconnected = true;
  const scheduler = createMessageRecoveryScheduler(client, {
    runtime,
    classifyFailure: () => (permanent ? "permanent" : "temporary"),
    onState: runtime.onState,
  });
  const firstWait = runtime.waitFor((state) => state.phase === "waiting" && state.attempt === 1);
  scheduler.start();
  scheduler.start();
  scheduler.resume();
  const firstState = await firstWait;
  assert(firstState.waitMs === 500 && runtime.tasks.size === 1, "explicit opt-in schedules one 500 ms retry");
  report.push("scheduler-start-is-singleflight");

  const alertWait = runtime.waitFor((state) => state.phase === "waiting" && state.alerted);
  runtime.elapse(24 * 60 * 60 * 1000);
  await runtime.fireNext();
  const alertState = await alertWait;
  assert(alertState.waitMs === 1000 && runtime.tasks.size === 1, "24 hour alert keeps bounded retries active");
  report.push("scheduler-24h-alert-does-not-stop-retries");

  disconnected = false;
  const recoveredWait = runtime.waitFor((state) => state.phase === "idle");
  await runtime.fireNext();
  const recoveredState = await recoveredWait;
  assert(runtime.tasks.size === 0 && readCalls >= 3, "temporary disconnect recovery resumes when transport returns");
  assert(
    !recoveredState.alerted && recoveredState.elapsedMs === 0,
    "successful recovery resets the 24 hour failure episode",
  );
  report.push("scheduler-recovers-after-temporary-disconnect");
  report.push("scheduler-success-resets-alert-episode");

  disconnected = true;
  permanent = true;
  const stoppedWait = runtime.waitFor((state) => state.phase === "stopped" && state.reason === "permanent");
  scheduler.resume();
  await stoppedWait;
  assert(runtime.tasks.size === 0, "trusted permanent classification clears retry timer");
  report.push("scheduler-permanent-classification-stops");
  scheduler.dispose();

  let readEntered: () => void = () => {};
  let releaseRead: () => void = () => {};
  let racingReads = 0;
  const readEnteredPromise = new Promise<void>((resolve) => (readEntered = resolve));
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
  const raceTransport: MessageRecoveryTransport = {
    async recordDurableChatRequest(): Promise<unknown> {
      throw new Error("unused in scheduler generation race");
    },
    async readEvents(_scope, _cursor) {
      racingReads += 1;
      if (racingReads === 1) {
        readEntered();
        await readGate;
      }
      return { status: "events", events: [], cursor: { scopeKey: "race-scope", sequence: 0 }, hasMore: false };
    },
    async readChatInboxSnapshot() {
      throw new Error("unused in scheduler generation race");
    },
  };
  const raceRuntime = new FakeRuntime();
  const raceClient = createMessageRecoveryController({
    scope,
    store: new Store(),
    transport: raceTransport,
    createRequestId: () => "unused-race-id",
    classifyTransportFailure: () => "temporary",
  });
  const raceScheduler = createMessageRecoveryScheduler(raceClient, {
    runtime: raceRuntime,
    classifyFailure: () => "temporary",
    onState: raceRuntime.onState,
  });
  const raceIdle = raceRuntime.waitFor((state) => state.phase === "idle");
  raceScheduler.start();
  await readEnteredPromise;
  raceScheduler.stop();
  raceScheduler.start();
  releaseRead();
  await raceIdle;
  assert(
    racingReads === 2 && raceRuntime.tasks.size === 0,
    "new scheduler generation runs after a stale in-flight generation finishes",
  );
  report.push("scheduler-stop-start-old-flight-generation-safe");
  raceScheduler.dispose();

  authorized = false;
  disconnected = false;
  const authRuntime = new FakeRuntime();
  const authClient = createMessageRecoveryController({
    scope,
    store: new Store(),
    transport,
    createRequestId: () => "unused-auth-id",
    classifyTransportFailure: (error) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "UNAUTHORIZED"
        ? "permanent"
        : "temporary",
  });
  const authScheduler = createMessageRecoveryScheduler(authClient, {
    runtime: authRuntime,
    classifyFailure: classifyMessageRecoveryFailure,
    onState: authRuntime.onState,
  });
  const authStopped = authRuntime.waitFor((state) => state.phase === "stopped" && state.reason === "permanent");
  authScheduler.start();
  await authStopped;
  assert(authRuntime.tasks.size === 0, "trusted Host auth rejection survives typed wrapping and stops retries");
  report.push("host-auth-error-remains-permanent-after-wrapping");
  authScheduler.dispose();
  authorized = true;

  const cancelRuntime = new FakeRuntime();
  disconnected = true;
  permanent = false;
  const cancelClient = createMessageRecoveryController({
    scope,
    store: new Store(),
    transport,
    createRequestId: () => "cancel-request-id",
    classifyTransportFailure: () => "temporary",
  });
  const cancelScheduler = createMessageRecoveryScheduler(cancelClient, {
    runtime: cancelRuntime,
    classifyFailure: () => "temporary",
    onState: cancelRuntime.onState,
  });
  const cancelWait = cancelRuntime.waitFor((state) => state.phase === "waiting");
  cancelScheduler.start();
  await cancelWait;
  cancelScheduler.logout();
  assert(cancelRuntime.tasks.size === 0, "dispose cancels timer and controller generation");
  report.push("scheduler-logout-cancels-timer-and-generation");
} finally {
  database.close();
  await rm(tempRoot, { recursive: true, force: true });
}

await mkdir(".openbot-build", { recursive: true });
await writeFile(
  ".openbot-build/011-client-recovery-scheduler-e2e.json",
  `${JSON.stringify({ checks: report, hostReadCalls: readCalls }, null, 2)}\n`,
);
