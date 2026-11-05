// Exercises Host inbox delivery through the real AgentService, MailboxStore and SQLite databases.
// A small local Codex app-server stand-in completes turns; this script never calls a real model.
// Run after the Host delivery ledger schema is available with `node --import tsx`.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { HostChatRecoveryScope } from "../src/backend/database/host-chat-recovery";
import { isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/011-host-chat-delivery-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-011-host-delivery-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_HOST_DELIVERY_CODEX_LOG = fakeLog;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.162.1\\n");
  process.exit(0);
}
const LOG = process.env.OPENBOT_HOST_DELIVERY_CODEX_LOG;
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threadNumber = 0;
let turnNumber = 0;
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); throw error; });
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "fixture-thread-" + (++threadNumber), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "fixture-turn-" + (++turnNumber);
      const text = (params.input || []).map((part) => part.text || "").join("\\n");
      log({ method: "turn/start", threadId: params.threadId, turnId, text });
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      setTimeout(() => {
        const item = { type: "agentMessage", id: "fixture-answer-" + turnId, text: "Fixture answer.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 20);
      return;
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default: return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      log({ method: message.method ?? null, id: message.id ?? null });
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: { checks: Array<{ name: string; passed: boolean }>; passed: boolean; error?: string } = {
  checks: [],
  passed: false,
};
function pass(name: string, condition: boolean, detail?: string): void {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
}
function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const check = () => {
      const value = read();
      if (value) return resolvePromise(value);
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}.`));
      setTimeout(check, 20);
    };
    check();
  });
}
const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const scope: HostChatRecoveryScope = {
  hostId: "host-delivery-e2e",
  userId: "user-delivery-e2e",
  deviceId: "device-delivery-e2e",
  grantId: "grant-delivery-e2e",
  capability: "chat",
  hostEpoch: 1,
  authEpoch: 1,
  grantEpoch: 1,
};
let authorized = true;
let database = new OpenBotDatabase(userData);
let store = new AgentStore(userData, home, database);
let mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const authorize = (candidate: HostChatRecoveryScope, target?: { agentId: string; threadId: string }) =>
  authorized &&
  candidate.hostId === scope.hostId &&
  candidate.userId === scope.userId &&
  candidate.deviceId === scope.deviceId &&
  candidate.grantId === scope.grantId &&
  (!target || (target.agentId === agentId && target.threadId === threadId));
let agentId = "";
let threadId = "";

function turnsFor(text: string): Array<{ method: string; threadId: string; turnId: string; text: string }> {
  try {
    return readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .filter(
        (value): value is { method: string; threadId: string; turnId: string; text: string } =>
          typeof value === "object" &&
          value !== null &&
          "method" in value &&
          value.method === "turn/start" &&
          "threadId" in value &&
          typeof value.threadId === "string" &&
          "turnId" in value &&
          typeof value.turnId === "string" &&
          "text" in value &&
          typeof value.text === "string" &&
          value.text.includes(text),
      );
  } catch {
    return [];
  }
}

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Host delivery fixture",
      description: "Checks durable Host chat dispatch.",
      avatarSeed: "host-delivery-fixture",
      avatarHue: null,
      initialMessage: "Bootstrap turn.",
    }),
  );
  agentId = agent.id;
  threadId = store.ensureThreadIdNow(agentId);
  assert.ok(
    agentId.length > 0 && threadId.length > 0,
    `Agent did not receive a durable thread identity: ${JSON.stringify({ agentId, threadId })}`,
  );
  await waitFor(
    "bootstrap turn completion",
    () =>
      turnsFor("Bootstrap turn.").length === 1 &&
      mailbox.listQueue(agentId).deliveries.every((delivery) => delivery.status === "completed"),
  );
  const enqueue = (requestId: string, content: string, requestThread = threadId) =>
    database.recordDurableChatRequest(
      {
        scope,
        requestId,
        target: { agentId, threadId: requestThread },
        content,
      },
      (candidateScope, target) => authorize(candidateScope, target),
    );
  const send = (requestId: string) => runCauseEffect(agents.sendDurableHostChat({ scope, requestId, authorize }));
  const firstRequest = "host-delivery-first";
  const firstContent = "Accepted Host message one.";
  enqueue(firstRequest, firstContent);
  const turnsBeforeFirst = turnsFor(firstContent).length;
  const droppedReply = await send(firstRequest);
  const firstDeliveryId = droppedReply.deliveries[0]?.id;
  assert.ok(firstDeliveryId, "Host delivery did not return a queued receipt.");
  await waitFor(
    "first Host delivery completion",
    () => mailbox.getDelivery(firstDeliveryId)?.delivery.status === "completed",
  );
  const conversation = await runCauseEffect(agents.readConversation(agentId));
  pass(
    "real Host delivery reaches the mailbox, Codex stand-in and persisted conversation",
    conversation.messages.some((message) => message.text === firstContent) &&
      conversation.messages.some((message) => message.text === "Fixture answer.") &&
      turnsFor(firstContent).length === turnsBeforeFirst + 1,
  );

  await runCauseEffect(agents.stop());
  database.close();
  database = new OpenBotDatabase(userData);
  await runCauseEffect(database.initialize());
  store = new AgentStore(userData, home, database);
  mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  });
  const persistedReceiptJson = database.connection
    .prepare("SELECT receipt_json FROM host_chat_delivery_ledger WHERE request_id=?")
    .get(firstRequest)?.receipt_json;
  assert.equal(typeof persistedReceiptJson, "string", "Host delivery receipt was not committed to SQLite.");
  const durableValue = JSON.parse(String(persistedReceiptJson));
  const durableDeliveries = isRecord(durableValue) ? durableValue.deliveries : undefined;
  const durableDelivery = Array.isArray(durableDeliveries) ? durableDeliveries[0] : undefined;
  assert.ok(
    isRecord(durableDelivery) &&
      "position" in durableDelivery &&
      (durableDelivery.position === null || typeof durableDelivery.position === "number"),
    `Stored receipt delivery has no decodable position: ${String(persistedReceiptJson)}`,
  );
  const acceptedFirst = database.readAcceptedHostChatRequest(scope, firstRequest, authorize);
  const directReceipt = mailbox.readHostChatReceipt({
    scopeKey: acceptedFirst.scopeKey,
    requestId: acceptedFirst.requestId,
    requestHash: acceptedFirst.requestHash,
  });
  assert.ok(directReceipt, "The mailbox could not decode its just-written durable receipt.");
  const turnStartsBeforeRetry = turnsFor(firstContent).length;
  const restoredReceipt = await send(firstRequest);
  const sameStoredReceipt = JSON.stringify(restoredReceipt) === String(persistedReceiptJson);
  const noProviderTurnOnRetry = turnsFor(firstContent).length === turnStartsBeforeRetry;
  pass(
    "lost reply and process restart return the committed receipt without starting the provider",
    sameStoredReceipt && noProviderTurnOnRetry,
    JSON.stringify({ sameStoredReceipt, noProviderTurnOnRetry, persistedReceiptJson, restoredReceipt }),
  );

  await runCauseEffect(agents.initialize());
  const concurrentRequest = "host-delivery-concurrent";
  const concurrentContent = "Accepted concurrent Host message.";
  enqueue(concurrentRequest, concurrentContent);
  const [concurrentA, concurrentB] = await Promise.all([send(concurrentRequest), send(concurrentRequest)]);
  assert.deepEqual(concurrentA, concurrentB, "Concurrent Host calls returned different receipts.");
  const concurrentDeliveryId = concurrentA.deliveries[0]?.id;
  assert.ok(concurrentDeliveryId, "Concurrent Host request has no queue delivery.");
  await waitFor(
    "concurrent Host turn completion",
    () => mailbox.getDelivery(concurrentDeliveryId)?.delivery.status === "completed",
  );
  const concurrentRows = Number(
    database.connection
      .prepare("SELECT count(*) AS count FROM host_chat_delivery_ledger WHERE request_id=?")
      .get(concurrentRequest)?.count ?? 0,
  );
  pass(
    "concurrent duplicate calls commit and execute one queue delivery",
    concurrentRows === 1 &&
      turnsFor(concurrentContent).length === 1 &&
      mailbox.listQueue(agentId).deliveries.filter((delivery) => delivery.id === concurrentDeliveryId).length === 1,
  );

  const beforeRejected = mailbox.listQueue(agentId).deliveries.length;
  const noReceiptRequest = "host-delivery-not-accepted";
  await assert.rejects(() => send(noReceiptRequest));
  const revokedRequest = "host-delivery-revoked";
  enqueue(revokedRequest, "Accepted, then revoked.");
  authorized = false;
  await assert.rejects(() => send(revokedRequest));
  authorized = true;
  const changedThreadRequest = "host-delivery-changed-thread";
  enqueue(changedThreadRequest, "Accepted for old thread.");
  store.restoreThreadIdentity(agentId, "fixture-new-thread-after-acceptance", null);
  await assert.rejects(() => send(changedThreadRequest));
  store.restoreThreadIdentity(agentId, threadId, null);
  pass(
    "unaccepted, revoked and stale-thread requests are refused without queue changes",
    mailbox.listQueue(agentId).deliveries.length === beforeRejected &&
      Number(
        database.connection
          .prepare("SELECT count(*) AS count FROM host_chat_delivery_ledger WHERE request_id IN (?, ?, ?)")
          .get(noReceiptRequest, revokedRequest, changedThreadRequest)?.count ?? 0,
      ) === 0,
  );

  const rollbackRequest = "host-delivery-rollback";
  const rollbackContent = "Accepted Host message after rollback.";
  enqueue(rollbackRequest, rollbackContent);
  const beforeRollbackCount = mailbox.listQueue(agentId).deliveries.length;
  const observedEvents: string[] = [];
  const eventListener = (event: { type: string }) => observedEvents.push(event.type);
  agents.on("event", eventListener);
  database.connection.exec(
    `CREATE TEMP TRIGGER fail_host_chat_delivery BEFORE INSERT ON host_chat_delivery_ledger WHEN new.request_id = '${rollbackRequest}' BEGIN SELECT RAISE(ABORT, 'fixture interrupted commit'); END`,
  );
  await assert.rejects(() => send(rollbackRequest));
  database.connection.exec("DROP TRIGGER fail_host_chat_delivery");
  agents.off("event", eventListener);
  const rollbackLedgerCount = Number(
    database.connection
      .prepare("SELECT count(*) AS count FROM host_chat_delivery_ledger WHERE request_id=?")
      .get(rollbackRequest)?.count ?? 0,
  );
  const rollbackProjectionCount = Number(
    database.connection
      .prepare("SELECT count(*) AS count FROM projection_mailbox_messages WHERE text=?")
      .get(rollbackContent)?.count ?? 0,
  );
  pass(
    "SQLite failure rolls back the ledger, mailbox memory and notifications",
    rollbackLedgerCount === 0 &&
      rollbackProjectionCount === 0 &&
      mailbox.listQueue(agentId).deliveries.length === beforeRollbackCount &&
      !observedEvents.some((type) =>
        [
          "conversation",
          "conversation-delta",
          "conversation-invalidated",
          "queue-changed",
          "queue-invalidated",
        ].includes(type),
      ),
  );
  const recoveredRollback = await send(rollbackRequest);
  const rollbackDeliveryId = recoveredRollback.deliveries[0]?.id;
  assert.ok(rollbackDeliveryId, "Retry after rollback has no queue delivery.");
  await waitFor(
    "post-rollback Host turn completion",
    () => mailbox.getDelivery(rollbackDeliveryId)?.delivery.status === "completed",
  );
  pass("retry after an interrupted commit enqueues and executes once", turnsFor(rollbackContent).length === 1);

  const permanentReceiptCount = Number(
    database.connection.prepare("SELECT count(*) AS count FROM host_chat_delivery_ledger").get()?.count ?? 0,
  );
  await runCauseEffect(mailbox.deleteAgentData(agentId));
  const retainedReceiptCount = Number(
    database.connection.prepare("SELECT count(*) AS count FROM host_chat_delivery_ledger").get()?.count ?? 0,
  );
  const retainedAfterHistoryDeletion = await send(firstRequest);
  pass(
    "mailbox history deletion retains durable receipts while queue history is gone",
    permanentReceiptCount === retainedReceiptCount &&
      JSON.stringify(retainedAfterHistoryDeletion) === String(persistedReceiptJson) &&
      mailbox.getDelivery(firstDeliveryId) === null,
  );
  report.passed = report.checks.every((check) => check.passed);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const check of report.checks) process.stdout.write(`${check.passed ? "PASS" : "FAIL"} ${check.name}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (!report.passed) process.exitCode = 1;
}
