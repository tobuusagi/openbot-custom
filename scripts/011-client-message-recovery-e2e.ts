import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatInboxSnapshot,
  DurableChatReceipt,
  MessageRecoveryCursor,
  MessageRecoveryScope,
  MessageRecoveryStore,
  MessageRecoveryTransport,
  RecoveredChatEvent,
} from "@openbot/team-client/message-recovery";
import { createMessageRecoveryController } from "@openbot/team-client/message-recovery";
import { runCauseEffect } from "../src/backend/effect-boundary";
import {
  type HostChatRecoveryScope,
  type HostChatRecoveryTarget,
  OpenBotDatabase,
} from "../src/backend/openbot-database";

const scope: MessageRecoveryScope = {
  hostId: "host-a",
  userId: "user-a",
  deviceId: "device-a",
  grantId: "grant-a",
  capability: "chat",
  hostEpoch: 1,
  authEpoch: 2,
  grantEpoch: 3,
};
const target = { agentId: "agent-a", threadId: "thread-a" };
const report: string[] = [];
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function fixtureInboxSnapshot(sequence: number): ChatInboxSnapshot {
  return {
    type: "host-chat-inbox-snapshot",
    complete: true,
    acceptedRequests: Array.from({ length: sequence }, (_, index) => ({
      sequence: index + 1,
      messageId: `message-${index + 1}`,
      requestId: `request-${index + 1}`,
      target,
      content: `fixture chat ${index + 1}`,
      acceptedAt: "2026-11-05T00:00:00.000Z",
    })),
    cursor: { scopeKey: "scope-a", sequence },
  };
}
function isInboxSnapshot(value: unknown): value is ChatInboxSnapshot {
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

class MemoryStore implements MessageRecoveryStore {
  #cursor: MessageRecoveryCursor | undefined;
  get cursor(): MessageRecoveryCursor | undefined {
    return this.#cursor;
  }
  failNextEventWrite = false;
  events = new Map<string, RecoveredChatEvent>();
  pending: { requestId: string; target: typeof target; content: string }[] = [];
  acknowledged: string[] = [];
  acknowledgedReceipts: DurableChatReceipt[] = [];
  snapshot: unknown;
  async enqueuePendingChat(_scope: MessageRecoveryScope, request: (typeof this.pending)[number]) {
    this.pending.push(request);
  }
  async listPendingChats(_scope: MessageRecoveryScope, _signal: AbortSignal) {
    return [...this.pending];
  }
  async acknowledgePendingChat(_scope: MessageRecoveryScope, requestId: string, _receipt: DurableChatReceipt) {
    this.acknowledged.push(requestId);
    this.acknowledgedReceipts.push(_receipt);
    this.pending = this.pending.filter((request) => request.requestId !== requestId);
  }
  async readCursor() {
    return this.cursor;
  }
  async storeEvent(_scope: MessageRecoveryScope, event: RecoveredChatEvent) {
    if (this.failNextEventWrite) {
      this.failNextEventWrite = false;
      throw new Error("fixture storage failure");
    }
    const byMessage = this.events.get(event.messageId);
    const bySequence = [...this.events.values()].find((stored) => stored.sequence === event.sequence);
    if (
      (byMessage && JSON.stringify(byMessage) !== JSON.stringify(event)) ||
      (bySequence && JSON.stringify(bySequence) !== JSON.stringify(event))
    )
      throw new Error("fixture event conflict");
    this.events.set(event.messageId, event);
  }
  async advanceCursor(_scope: MessageRecoveryScope, cursor: MessageRecoveryCursor) {
    this.#cursor = cursor;
  }
  async replaceSnapshotAndCursor(_scope: MessageRecoveryScope, body: unknown, cursor: MessageRecoveryCursor) {
    this.snapshot = body;
    this.events.clear();
    this.#cursor = cursor;
  }
}

class DeferredFirstListStore extends MemoryStore {
  signalFirstList: () => void = () => {};
  releaseFirstList: () => void = () => {};
  readonly firstListStarted: Promise<void>;
  readonly firstListGate: Promise<void>;
  first = true;
  constructor() {
    super();
    this.firstListStarted = new Promise<void>((resolve) => (this.signalFirstList = resolve));
    this.firstListGate = new Promise<void>((resolve) => (this.releaseFirstList = resolve));
  }
  override async listPendingChats(scope: MessageRecoveryScope, signal: AbortSignal) {
    const snapshot = await super.listPendingChats(scope, signal);
    if (this.first) {
      this.first = false;
      this.signalFirstList();
      await this.firstListGate;
    }
    return snapshot;
  }
}

class FixtureTransport implements MessageRecoveryTransport {
  response: unknown = { status: "events", events: [], cursor: { scopeKey: "scope-a", sequence: 0 }, hasMore: false };
  snapshot: unknown = fixtureInboxSnapshot(0);
  receiptCalls = 0;
  ackOnly = false;
  deferredEvents: Promise<void> | undefined;
  resolveEvents: (() => void) | undefined;
  eventsEntered: (() => void) | undefined;
  async recordDurableChatRequest(input: { requestId: string }): Promise<unknown> {
    this.receiptCalls += 1;
    if (this.ackOnly) return { transportAck: true };
    return {
      receiptId: `receipt-${input.requestId}`,
      requestId: input.requestId,
      messageId: "message-a",
      eventSequence: 1,
      acceptedAt: "2026-11-05T00:00:00.000Z",
    };
  }
  async readEvents(_scope: MessageRecoveryScope, _cursor: MessageRecoveryCursor | undefined) {
    this.eventsEntered?.();
    if (this.deferredEvents) await this.deferredEvents;
    return this.response;
  }
  async readChatInboxSnapshot() {
    return this.snapshot;
  }
}

function controller(store: MemoryStore, transport: FixtureTransport, id = "00000000000000000000000000000001") {
  return createMessageRecoveryController({
    scope,
    store,
    transport,
    createRequestId: () => id,
    classifyTransportFailure: () => "temporary",
  });
}

const store = new MemoryStore();
const transport = new FixtureTransport();
const client = controller(store, transport);

await client.sendChat(target, "fixture chat");
assert(store.acknowledged.length === 1 && store.pending.length === 0, "durable Host receipt clears chat outbox");
assert(transport.receiptCalls === 1, "chat is sent through the Host receipt operation");
report.push("outbox-cleared-after-durable-host-receipt");

const unreceiptedStore = new MemoryStore();
const ackOnlyTransport = new FixtureTransport();
ackOnlyTransport.ackOnly = true;
const unreceiptedClient = controller(unreceiptedStore, ackOnlyTransport, "00000000000000000000000000000002");
await unreceiptedClient.sendChat(target, "must remain pending").then(
  () => {
    throw new Error("transport ACK cannot clear pending chat");
  },
  () => undefined,
);
assert(
  unreceiptedStore.pending.length === 1 && unreceiptedStore.acknowledged.length === 0,
  "non-receipt leaves chat in durable outbox",
);
report.push("transport-ack-does-not-clear-outbox");

const racingStore = new DeferredFirstListStore();
const racingTransport = new FixtureTransport();
let nextRequest = 10;
const racingClient = createMessageRecoveryController({
  scope,
  store: racingStore,
  transport: racingTransport,
  createRequestId: () => String(nextRequest++).padStart(32, "0"),
  classifyTransportFailure: () => "temporary",
});
const firstSend = racingClient.sendChat(target, "first");
await racingStore.firstListStarted;
const secondSend = racingClient.sendChat(target, "second");
racingStore.releaseFirstList();
await Promise.all([firstSend, secondSend]);
assert(
  racingStore.pending.length === 0 && racingStore.acknowledged.length === 2,
  "singleflight drain includes a chat enqueued during its first pending snapshot",
);
report.push("outbox-drain-covers-concurrent-enqueue");

transport.response = {
  status: "events",
  events: [
    {
      sequence: 1,
      messageId: "message-1",
      requestId: "request-1",
      target,
      content: "fixture event",
      occurredAt: "2026-11-05T00:00:00.000Z",
    },
  ],
  cursor: { scopeKey: "scope-a", sequence: 1 },
  hasMore: false,
};
store.failNextEventWrite = true;
await client.recover().then(
  () => {
    throw new Error("event storage failure must reject recovery");
  },
  () => undefined,
);
assert(store.cursor === undefined, "failed event persistence does not advance cursor");
report.push("failed-event-persistence-keeps-cursor");

await client.recover();
assert(store.cursor?.sequence === 1 && store.events.size === 1, "event persists before cursor advances");
await client.recover();
assert(store.events.size === 1 && store.cursor?.sequence === 1, "duplicate event is idempotent");
report.push("event-before-cursor-and-duplicate-safe");

transport.response = {
  status: "events",
  events: [
    {
      sequence: 1,
      messageId: "message-1",
      requestId: "request-1",
      target,
      content: "conflicting replay",
      occurredAt: "2026-11-05T00:00:00.000Z",
    },
  ],
  cursor: { scopeKey: "scope-a", sequence: 1 },
  hasMore: false,
};
await client.recover().then(
  () => {
    throw new Error("conflicting duplicate event must fail");
  },
  () => undefined,
);
assert(
  store.cursor?.sequence === 1 && store.events.size === 1,
  "conflicting event cannot replace stored event or cursor",
);
report.push("conflicting-duplicate-event-rejected");

transport.response = {
  status: "events",
  events: [
    {
      sequence: 3,
      messageId: "message-3",
      requestId: "request-3",
      target,
      content: "gap event",
      occurredAt: "2026-11-05T00:00:00.000Z",
    },
  ],
  cursor: { scopeKey: "scope-a", sequence: 3 },
  hasMore: false,
};
transport.snapshot = fixtureInboxSnapshot(5);
await client.recover();
assert(
  store.cursor?.sequence === 5 && store.events.size === 0,
  "gap replaces event state with a complete snapshot and cursor",
);
assert(
  isInboxSnapshot(store.snapshot) && store.snapshot.acceptedRequests.length === 5,
  "snapshot contains the inbox acceptance ledger",
);
report.push("cursor-gap-requires-snapshot");

transport.response = { status: "snapshot-required", reason: "scope-changed" };
transport.snapshot = fixtureInboxSnapshot(8);
await client.recover();
assert(
  store.cursor?.sequence === 8 && isInboxSnapshot(store.snapshot) && store.snapshot.acceptedRequests.length === 8,
  "snapshot replaces data and cursor",
);
report.push("snapshot-and-cursor-replaced");

const staleStore = new MemoryStore();
const staleTransport = new FixtureTransport();
staleTransport.deferredEvents = new Promise<void>((resolve) => (staleTransport.resolveEvents = resolve));
const staleClient = controller(staleStore, staleTransport);
const eventsEntered = new Promise<void>((resolve) => (staleTransport.eventsEntered = resolve));
const oldRecovery = staleClient.recover().catch(() => undefined);
await eventsEntered;
staleClient.revoke();
staleTransport.response = {
  status: "events",
  events: [
    {
      sequence: 1,
      messageId: "late-event",
      requestId: "late-request",
      target,
      content: "late",
      occurredAt: "2026-11-05T00:00:00.000Z",
    },
  ],
  cursor: { scopeKey: "scope-a", sequence: 1 },
  hasMore: false,
};
staleTransport.resolveEvents?.();
await oldRecovery;
assert(
  staleStore.cursor === undefined && staleStore.events.size === 0,
  "late response after revoke cannot update local state",
);
report.push("revoke-cancels-and-isolates-late-response");

const hostTempRoot = await mkdtemp(join(tmpdir(), "openbot-011-client-recovery-"));
const hostDatabase = new OpenBotDatabase(join(hostTempRoot, "state"));
const hostScope: HostChatRecoveryScope = {
  hostId: "integration-host",
  userId: "integration-user",
  deviceId: "integration-device",
  grantId: "integration-grant",
  capability: "chat",
  hostEpoch: 2,
  authEpoch: 4,
  grantEpoch: 6,
};
const hostTarget: HostChatRecoveryTarget = { agentId: "integration-agent", threadId: "integration-thread" };
let authorizationActive = true;
let dropNextReceiptReply = true;
let hostReadCalls = 0;
const hostAuthorize = (candidateScope: HostChatRecoveryScope, candidateTarget?: HostChatRecoveryTarget) =>
  authorizationActive &&
  candidateScope.hostId === hostScope.hostId &&
  candidateScope.userId === hostScope.userId &&
  candidateScope.deviceId === hostScope.deviceId &&
  candidateScope.grantId === hostScope.grantId &&
  (!candidateTarget ||
    (candidateTarget.agentId === hostTarget.agentId && candidateTarget.threadId === hostTarget.threadId));

try {
  await runCauseEffect(hostDatabase.initialize());
  const hostStore = new MemoryStore();
  // This injected in-process bridge exercises the real Host facade; it is not a main IPC or WSS route.
  const hostTransport: MessageRecoveryTransport = {
    async recordDurableChatRequest(input) {
      const receipt = hostDatabase.recordDurableChatRequest(input, hostAuthorize);
      if (dropNextReceiptReply) {
        dropNextReceiptReply = false;
        throw new Error("fixture bridge lost the reply after Host commit");
      }
      return receipt;
    },
    async readEvents(candidateScope, afterCursor) {
      hostReadCalls += 1;
      return hostDatabase.readDurableChatEvents(candidateScope, afterCursor, hostAuthorize);
    },
    async readChatInboxSnapshot(candidateScope) {
      return hostDatabase.readDurableChatSnapshot(candidateScope, hostAuthorize);
    },
  };
  let hostRequestNumber = 0;
  const hostClient = createMessageRecoveryController({
    scope: hostScope,
    store: hostStore,
    transport: hostTransport,
    createRequestId: () => `integration-${String(++hostRequestNumber).padStart(8, "0")}`,
    classifyTransportFailure: (error) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "UNAUTHORIZED"
        ? "permanent"
        : "temporary",
  });
  await hostClient.sendChat(hostTarget, "committed before bridge reply loss").then(
    () => {
      throw new Error("dropped receipt response must leave chat pending");
    },
    () => undefined,
  );
  assert(hostStore.pending.length === 1, "lost receipt reply preserves pending outbox row");
  assert(
    hostDatabase.connection.prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_messages").get()?.count === 1,
    "Host committed chat before bridge reply was lost",
  );
  const firstPending = hostStore.pending[0];
  if (firstPending === undefined) throw new Error("lost Host receipt remains in the local outbox");
  const originalReceipt = hostDatabase.recordDurableChatRequest(
    { scope: hostScope, target: hostTarget, requestId: firstPending.requestId, content: firstPending.content },
    hostAuthorize,
  );
  await hostClient.flushOutbox();
  assert(
    hostStore.pending.length === 0 && hostStore.acknowledged.length === 1,
    "same request retry clears outbox after original Host receipt",
  );
  assert(
    JSON.stringify(hostStore.acknowledgedReceipts[0]) === JSON.stringify(originalReceipt),
    "same request retry returns the original Host receipt",
  );
  assert(
    hostDatabase.connection.prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_messages").get()?.count === 1,
    "retry returns original Host receipt without a second durable message",
  );
  report.push("host-commit-retry-returns-original-receipt");

  for (let index = 0; index < 405; index += 1) {
    hostDatabase.recordDurableChatRequest(
      {
        scope: hostScope,
        target: hostTarget,
        requestId: `page-${String(index).padStart(5, "0")}`,
        content: `page content ${index}`,
      },
      hostAuthorize,
    );
  }
  await hostClient.recover();
  assert(
    hostReadCalls === 4 && hostStore.events.size === 400,
    "controller follows real Host pages to its bounded four-page stop",
  );
  assert(hostStore.cursor?.sequence === 400, "page cursor advances only through locally persisted events");
  await hostClient.recover();
  assert(
    hostReadCalls === 5 && hostStore.events.size === 406,
    "next recovery resumes from the saved cursor and drains remaining Host events",
  );
  assert(hostStore.cursor?.sequence === 406, "Host event cursor reaches the actual durable page tail");
  report.push("host-pagination-resumes-from-durable-page-cursor");

  const beforeRevokeCursor = hostStore.cursor?.sequence;
  authorizationActive = false;
  await hostClient.recover().then(
    () => {
      throw new Error("revoked Host scope must reject event recovery");
    },
    () => undefined,
  );
  assert(hostStore.cursor?.sequence === beforeRevokeCursor, "revoked Host scope does not advance local cursor");
  report.push("host-authorization-revoke-keeps-cursor");
  hostClient.dispose();
} finally {
  hostDatabase.close();
  await rm(hostTempRoot, { recursive: true, force: true });
}

const outputPath = ".openbot-build/011-client-message-recovery-e2e.json";
await mkdir(".openbot-build", { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ checks: report }, null, 2)}\n`);
