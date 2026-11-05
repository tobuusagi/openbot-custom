// Authenticated local HTTP E2E for Team API Host chat recovery. Uses the real TeamStore, OpenBotDatabase,
// AgentService and MailboxStore with a local Codex app-server stand-in. It does not call a real provider.
// Run: `node --import tsx --experimental-loader ./scripts/011-authenticated-chat-recovery-electron-loader.mjs scripts/011-authenticated-chat-recovery-e2e.ts`.
// Writes `.openbot-build/011-authenticated-chat-recovery-e2e/report.json`.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  decodeHostChatEventPage,
  decodeHostChatInboxSnapshot,
  decodeHostChatQueuedReceipt,
  decodeHostChatReceipt,
  decodeHostChatRecoveryScope,
  HOST_CHAT_RECOVERY_CAPABILITY,
  HOST_CHAT_RECOVERY_ROUTES,
} from "@openbot/contracts/team-protocol/host-chat-recovery-v1";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import type { AuthenticatedTeamApiRequest } from "@openbot/team-client/host-chat-recovery-transport";
import { AuthenticatedTeamApiRequestError } from "@openbot/team-client/host-chat-recovery-transport";
import { Effect } from "effect";
import type { AgentClientFactory } from "../src/backend/agent/provider-runtime";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient } from "../src/backend/agent-client";
import type { AgentService as AgentServiceType } from "../src/backend/agent-service";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { MailboxStore as MailboxStoreType } from "../src/backend/mailbox-store";
import type { OpenBotDatabase as OpenBotDatabaseType } from "../src/backend/openbot-database";
import { ProviderClientOperationError } from "../src/backend/provider-client-effects";
import type { AgentAccessState } from "../src/main/agent-access-store";
import type { ClientRecoveryService } from "../src/main/client-recovery-service";
import type { TeamApiBrowser, TeamApiHostChatRecovery } from "../src/main/team-api/dependencies";
import type { TeamApiServer as TeamApiServerType } from "../src/main/team-api-server";
import { TeamStore } from "../src/main/team-store";

const out = resolve(import.meta.dirname, "../.openbot-build/011-authenticated-chat-recovery-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-011-auth-chat-http-"));
const home = join(root, "home");
const userData = join(root, "user-data");
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = process.execPath;
mkdirSync(home, { recursive: true });

class FakeCodex extends EventEmitter implements AgentClient {
  readonly provider = "codex" as const;
  running = false;
  #thread = 0;
  #turn = 0;

  start(): void {
    this.running = true;
  }
  stop() {
    this.running = false;
    return Effect.void;
  }
  notify(): void {}
  respond(): void {}
  respondError(): void {}
  request<T>(method: string, params: unknown, decode: (value: unknown) => T) {
    return Effect.try({
      try: () => decode(this.#result(method, params)),
      catch: (cause) => new ProviderClientOperationError({ cause }),
    });
  }
  #result(method: string, params: unknown): unknown {
    const input = isDynamicRecord(params) ? params : {};
    switch (method) {
      case "initialize":
        return {};
      case "account/read":
        return { account: { type: "chatgpt", email: "fixture@example.com" } };
      case "account/rateLimits/read":
        return { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null };
      case "model/list":
        return { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] };
      case "plugin/list":
        return { marketplaces: [] };
      case "config/read":
        return {
          config: { mcp_servers: {} },
          layers: [
            {
              name: { type: "user", file: "/fake/.codex/config.toml", profile: null },
              version: "1",
              config: { mcp_servers: {} },
            },
          ],
        };
      case "config/batchWrite":
        return {};
      case "thread/start":
        return { thread: { id: `fake-thread-${++this.#thread}`, turns: [] } };
      case "thread/resume":
      case "thread/read":
        return { thread: { id: input.threadId, turns: [] } };
      case "thread/unsubscribe":
        return { status: "Unsubscribed" };
      case "thread/turns/list":
      case "thread/items/list":
        return { data: [], nextCursor: null };
      case "turn/start": {
        const threadId = String(input.threadId ?? "");
        const turnId = `fake-turn-${++this.#turn}`;
        setTimeout(() => {
          this.emit("notification", { method: "turn/started", params: { threadId, turn: { id: turnId } } });
          this.emit("notification", {
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: { type: "agentMessage", id: `answer-${turnId}`, text: "Fixture answer.", phase: "final_answer" },
            },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } },
          });
        }, 5);
        return { turn: { id: turnId, status: "inProgress", items: [] } };
      }
      case "turn/interrupt":
        return {};
      default:
        throw new Error("Fake Codex received an unsupported request.");
    }
  }
}

const unused = () => Effect.die(new Error("Unused in this E2E."));
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
const browserApi: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};
const report: { passed: boolean; checks: Array<{ name: string; passed: boolean }> } = { passed: false, checks: [] };
const pass = (name: string, condition: boolean, detail?: string) => {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
};
let database: OpenBotDatabaseType | undefined;
let api: TeamApiServerType | undefined;
let agents: AgentServiceType | undefined;
let mailbox: MailboxStoreType | undefined;
let clientRecovery: ClientRecoveryService | undefined;
const requiredAgents = (): AgentServiceType => {
  if (!agents) throw new Error("AgentService is not initialized.");
  return agents;
};
const requiredMailbox = (): MailboxStoreType => {
  if (!mailbox) throw new Error("MailboxStore is not initialized.");
  return mailbox;
};
const team = new TeamStore(join(root, "team.json"));

try {
  mkdirSync(out, { recursive: true });
  const [
    { OpenBotDatabase },
    { AgentLifecycleFailed, AgentService },
    { AgentStore },
    { MailboxStore },
    { TeamApiServer },
  ] = await Promise.all([
    import("../src/backend/openbot-database"),
    import("../src/backend/agent-service"),
    import("../src/backend/agent-store"),
    import("../src/backend/mailbox-store"),
    import("../src/main/team-api-server"),
  ]);
  database = new OpenBotDatabase(userData);
  await runCauseEffect(database.initialize());
  await runCauseEffect(team.initialize());
  await runCauseEffect(team.configure("Recovery E2E", "owner", "owner-password-e2e"));
  const invite = await runCauseEffect(team.createInvite("member"));
  const member = await runCauseEffect(team.acceptInvite(invite.token, "chat-member", "member-password-e2e"));
  const hostId = team.getIdentity()?.serverId;
  assert.ok(hostId);

  const store = new AgentStore(userData, home, database);
  mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const clientFactory: AgentClientFactory = () => new FakeCodex();
  agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    clientFactory,
    offProviders: AGENT_PROVIDERS.filter((p) => p !== "codex"),
  });
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Recovery fixture",
      description: "HTTP recovery E2E",
      avatarSeed: "recovery",
      avatarHue: null,
      initialMessage: "Bootstrap.",
    }),
  );
  const threadId = store.ensureThreadIdNow(agent.id);
  const waitForCompletedQueue = (agentId: string, expectedText?: string): Promise<void> =>
    new Promise((resolveDone) => {
      const check = () => {
        const allDeliveries = mailbox?.listQueue(agentId).deliveries ?? [];
        const deliveries = expectedText
          ? allDeliveries.filter((delivery) => delivery.text === expectedText)
          : allDeliveries;
        if (deliveries.length > 0 && deliveries.every((delivery) => delivery.status === "completed")) {
          requiredAgents().off("event", listener);
          resolveDone();
        }
      };
      const listener = (event: AgentEvent) => {
        if (event.type === "queue-changed" && event.snapshot?.agentId === agentId) check();
      };
      requiredAgents().on("event", listener);
      check();
    });
  await waitForCompletedQueue(agent.id);

  let access: AgentAccessState = { revision: 0, everyone: { [agent.id]: "chat" }, roles: [] };
  let failNextProviderDelivery = false;
  const hostChatRecovery: TeamApiHostChatRecovery = {
    listAgents: () => requiredAgents().listAgents(),
    isDurableHostChatTarget: (agentId, candidateThreadId) =>
      requiredAgents().isDurableHostChatTarget(agentId, candidateThreadId),
    recordDurableHostChatRequest: (input, authorize) => requiredAgents().recordDurableHostChatRequest(input, authorize),
    readDurableHostChatEvents: (scope, after, authorize) =>
      requiredAgents().readDurableHostChatEvents(scope, after, authorize),
    readDurableHostChatSnapshot: (scope, authorize) => requiredAgents().readDurableHostChatSnapshot(scope, authorize),
    sendDurableHostChat: (delivery) => {
      if (failNextProviderDelivery && delivery.requestId === "provider-timeout-retry") {
        failNextProviderDelivery = false;
        return Effect.fail(
          new AgentLifecycleFailed({ operation: "ensure message provider", cause: new Error("provider timeout") }),
        );
      }
      if (delivery.requestId !== "revoke-during-send") return requiredAgents().sendDurableHostChat(delivery);
      let targetAuthorizations = 0;
      const authorize: typeof delivery.authorize = (scope, target) => {
        if (target && ++targetAuthorizations === 2)
          access = { ...access, revision: access.revision + 1, everyone: { [agent.id]: "none" } };
        return delivery.authorize(scope, target);
      };
      return requiredAgents().sendDurableHostChat({ ...delivery, authorize });
    },
  };
  api = new TeamApiServer({
    appVersion: "e2e",
    store: team,
    agents,
    agentTasks: agents,
    hostChatRecovery,
    hostChatRecoveryAuthority: { hostEpoch: 11, authEpoch: 13, grantEpoch: 17 },
    agentAccess: {
      get: () => access,
      levels: () => access,
      subscribe: () => () => undefined,
      set: unused,
      copyAgent: unused,
    },
    mailbox,
    browser: browserApi,
  });
  const port = await Effect.runPromise(api.start());
  const base = `http://127.0.0.1:${port}`;
  const headers = (protocol: number, withCapability: boolean, token = member.sessionToken): Record<string, string> => ({
    [TEAM_PROTOCOL_VERSION_HEADER]: String(protocol),
    [TEAM_APP_VERSION_HEADER]: "e2e",
    [TEAM_CAPABILITIES_HEADER]: withCapability ? HOST_CHAT_RECOVERY_CAPABILITY : "",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  const post = (path: string, body: unknown, opts = headers(9, true)) =>
    fetch(`${base}${path}`, { method: "POST", headers: opts, body: JSON.stringify(body) });
  const get = (path: string, opts = headers(9, true)) => fetch(`${base}${path}`, { headers: opts });

  const unauthHeaders: Record<string, string> = { ...headers(9, true) };
  delete unauthHeaders.Authorization;
  const unauthenticated = await get(HOST_CHAT_RECOVERY_ROUTES.scope, unauthHeaders);
  pass("unauthenticated scope bootstrap is rejected", unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);
  const missingCapability = await get(HOST_CHAT_RECOVERY_ROUTES.scope, headers(9, false));
  pass("protocol 9 without the explicit capability is rejected", missingCapability.status === 400);
  const oldProtocol = await get(HOST_CHAT_RECOVERY_ROUTES.scope, headers(8, true));
  pass("protocol 8 cannot access recovery routes", oldProtocol.status === 400);

  const scopeReply = await get(HOST_CHAT_RECOVERY_ROUTES.scope);
  const scope = decodeHostChatRecoveryScope(await scopeReply.json());
  pass(
    "scope bootstrap uses Host, member, current session and configured logical namespace",
    scopeReply.status === 200 &&
      scope.hostId === hostId &&
      scope.userId === member.member.id &&
      team.memberAuthorizationRevision(member.member.id) === 0 &&
      scope.deviceId.length > 0 &&
      scope.deviceId === scope.grantId &&
      scope.hostEpoch === 11 &&
      Number.isSafeInteger(scope.authEpoch) &&
      scope.authEpoch > 0 &&
      scope.grantEpoch === 17 &&
      !JSON.stringify(scope).includes(member.sessionToken),
  );

  const stableScopeReply = await get(HOST_CHAT_RECOVERY_ROUTES.scope);
  pass(
    "same authenticated session returns the same server-owned scope",
    JSON.stringify(await stableScopeReply.json()) === JSON.stringify(scope),
  );

  await runCauseEffect(team.updateMember(member.member.id, { role: "admin" }));
  const adminScope = decodeHostChatRecoveryScope(await (await get(HOST_CHAT_RECOVERY_ROUTES.scope)).json());
  await runCauseEffect(team.updateMember(member.member.id, { role: "member" }));
  const restoredMemberScope = decodeHostChatRecoveryScope(await (await get(HOST_CHAT_RECOVERY_ROUTES.scope)).json());
  pass(
    "same-session role downgrade and restore each rotate the permission scope",
    adminScope.authEpoch !== scope.authEpoch &&
      restoredMemberScope.authEpoch !== adminScope.authEpoch &&
      restoredMemberScope.authEpoch !== scope.authEpoch,
  );

  const target = { agentId: agent.id, threadId };
  const requestId = "authenticated-recovery-request-1";
  const content = "Authenticated durable recovery chat.";
  const forged = await post(HOST_CHAT_RECOVERY_ROUTES.accept, {
    scope: { ...scope, userId: "forged" },
    target,
    requestId,
    content,
  });
  pass("client-supplied scope fields are rejected", forged.status === 400);
  const accepted = await post(HOST_CHAT_RECOVERY_ROUTES.accept, { target, requestId, content });
  const originalReceipt = decodeHostChatReceipt(await accepted.json());
  pass(
    "authorized request is durably accepted",
    accepted.status === 202 && originalReceipt.receiptId.length > 0,
    `HTTP ${accepted.status}; ${JSON.stringify(originalReceipt)}`,
  );
  const acceptedRetry = await post(HOST_CHAT_RECOVERY_ROUTES.accept, { target, requestId, content });
  pass(
    "accept retry returns the original durable receipt",
    JSON.stringify(decodeHostChatReceipt(await acceptedRetry.json())) === JSON.stringify(originalReceipt),
  );

  database.connection.exec("BEGIN IMMEDIATE");
  let temporaryFailure: Response;
  try {
    temporaryFailure = await post(HOST_CHAT_RECOVERY_ROUTES.accept, {
      target,
      requestId: "transient-sql-retry",
      content: "Retry after a temporary storage failure.",
    });
  } finally {
    database.connection.exec("ROLLBACK");
  }
  const temporaryFailureBody = await temporaryFailure.text();
  pass(
    "active SQLite transaction returns a sanitized retryable server error",
    temporaryFailure.status === 500 && !temporaryFailureBody.includes("TRANSACTION_ACTIVE"),
  );
  const temporaryRetry = await post(HOST_CHAT_RECOVERY_ROUTES.accept, {
    target,
    requestId: "transient-sql-retry",
    content: "Retry after a temporary storage failure.",
  });
  pass("same request can retry after temporary storage failure", temporaryRetry.status === 202);

  const providerTimeoutRequestId = "provider-timeout-retry";
  const providerTimeoutAccepted = await post(HOST_CHAT_RECOVERY_ROUTES.accept, {
    target,
    requestId: providerTimeoutRequestId,
    content: "Retry after a provider start timeout.",
  });
  failNextProviderDelivery = true;
  const providerTimeout = await post(HOST_CHAT_RECOVERY_ROUTES.consume, { requestId: providerTimeoutRequestId });
  pass(
    "provider timeout remains temporary and does not enqueue the chat",
    providerTimeoutAccepted.status === 202 &&
      providerTimeout.status === 500 &&
      !requiredMailbox()
        .listQueue(agent.id)
        .deliveries.some((delivery) => delivery.text === "Retry after a provider start timeout."),
  );
  const providerRetry = await post(HOST_CHAT_RECOVERY_ROUTES.consume, { requestId: providerTimeoutRequestId });
  pass("consume retries the same accepted request after provider timeout", providerRetry.status === 200);
  await waitForCompletedQueue(agent.id, "Retry after a provider start timeout.");

  const turnCompleted = waitForCompletedQueue(agent.id, content);
  const consumed = await post(HOST_CHAT_RECOVERY_ROUTES.consume, { requestId });
  const deliveryReceipt = decodeHostChatQueuedReceipt(await consumed.json());
  pass(
    "consume dispatches through the real AgentService",
    consumed.status === 200 && Array.isArray(deliveryReceipt.deliveries),
  );
  await turnCompleted;
  const conversation = await runCauseEffect(agents.readConversation(agent.id));
  pass(
    "FakeCodex completes the queued chat in the real conversation",
    conversation.messages.some((message) => message.text === content) &&
      conversation.messages.some((message) => message.text === "Fixture answer."),
  );
  const consumeRetry = await post(HOST_CHAT_RECOVERY_ROUTES.consume, { requestId });
  pass(
    "consume retry returns its original queue receipt",
    JSON.stringify(decodeHostChatQueuedReceipt(await consumeRetry.json())) === JSON.stringify(deliveryReceipt),
  );

  for (let index = 0; index < 101; index += 1) {
    const response = await post(HOST_CHAT_RECOVERY_ROUTES.accept, {
      target,
      requestId: `page-${index}`,
      content: `page content ${index}`,
    });
    assert.equal(response.status, 202);
  }
  const firstPageReply = await get(HOST_CHAT_RECOVERY_ROUTES.events);
  const firstPage = decodeHostChatEventPage(await firstPageReply.json());
  if (firstPage.status !== "events") throw new Error("Initial event page was not available.");
  const nextUrl = `${HOST_CHAT_RECOVERY_ROUTES.events}?after=${encodeURIComponent(JSON.stringify(firstPage.cursor))}`;
  const secondPageReply = await get(nextUrl);
  const secondPage = decodeHostChatEventPage(await secondPageReply.json());
  pass(
    "event replay is paged with a stable per-scope cursor",
    firstPageReply.status === 200 &&
      secondPage.status === "events" &&
      firstPage.events.length === 100 &&
      firstPage.hasMore &&
      secondPageReply.status === 200 &&
      secondPage.events.length === 4 &&
      secondPage.cursor.sequence === 104 &&
      !secondPage.hasMore,
  );

  const snapshotReply = await get(HOST_CHAT_RECOVERY_ROUTES.snapshot);
  const snapshot = decodeHostChatInboxSnapshot(await snapshotReply.json());
  pass(
    "snapshot returns all accepted requests",
    snapshotReply.status === 200 &&
      snapshot.type === "host-chat-inbox-snapshot" &&
      snapshot.complete &&
      snapshot.acceptedRequests.length === 104,
  );

  const revokeRequestId = "revoke-during-send";
  const revokeAccepted = await post(HOST_CHAT_RECOVERY_ROUTES.accept, {
    target,
    requestId: revokeRequestId,
    content: "Must not enter the queue after access is revoked.",
  });
  const revokeConsume = await post(HOST_CHAT_RECOVERY_ROUTES.consume, { requestId: revokeRequestId });
  pass(
    "permission revoked at the post-provider recheck blocks queue insertion",
    revokeAccepted.status === 202 &&
      revokeConsume.status === 404 &&
      !mailbox
        .listQueue(agent.id)
        .deliveries.some((delivery) => delivery.text === "Must not enter the queue after access is revoked."),
  );
  access = { ...access, revision: access.revision + 1, everyone: { [agent.id]: "chat" } };

  access = { ...access, revision: access.revision + 1, everyone: { [agent.id]: "none" } };
  const revokedEvents = await get(HOST_CHAT_RECOVERY_ROUTES.events);
  const revokedPage = decodeHostChatEventPage(await revokedEvents.json());
  const staleCursorReply = await get(
    `${HOST_CHAT_RECOVERY_ROUTES.events}?after=${encodeURIComponent(JSON.stringify(firstPage.cursor))}`,
  );
  const staleCursor = decodeHostChatEventPage(await staleCursorReply.json());
  const revokedSnapshotReply = await get(HOST_CHAT_RECOVERY_ROUTES.snapshot);
  const revokedSnapshot = decodeHostChatInboxSnapshot(await revokedSnapshotReply.json());
  pass(
    "revoked access gets a new authorization scope with no old message bodies",
    revokedEvents.status === 200 &&
      revokedPage.status === "events" &&
      revokedPage.events.length === 0 &&
      staleCursorReply.status === 200 &&
      staleCursor.status === "snapshot-required" &&
      staleCursor.reason === "scope-changed" &&
      revokedSnapshotReply.status === 200 &&
      revokedSnapshot.acceptedRequests.length === 0,
  );

  access = { ...access, revision: access.revision + 1, everyone: { [agent.id]: "chat" } };
  const regrantedScope = decodeHostChatRecoveryScope(await (await get(HOST_CHAT_RECOVERY_ROUTES.scope)).json());
  const regrantedSnapshot = decodeHostChatInboxSnapshot(await (await get(HOST_CHAT_RECOVERY_ROUTES.snapshot)).json());
  pass(
    "grant restoration cannot reopen an earlier authorization scope",
    regrantedScope.authEpoch !== scope.authEpoch && regrantedSnapshot.acceptedRequests.length === 0,
  );

  const { createClientRecoveryService } = await import("../src/main/client-recovery-service");
  const authenticatedCalls: string[] = [];
  let authenticatedCloseCount = 0;
  const authenticatedRequest: AuthenticatedTeamApiRequest = async (method, path, decode, body, signal) => {
    authenticatedCalls.push(`${method} ${path}`);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...headers(9, true),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new AuthenticatedTeamApiRequestError(response.status);
    return decode(await response.json());
  };
  clientRecovery = await createClientRecoveryService({ profilePath: join(root, "client-profile") });
  await clientRecovery.activate({
    request: authenticatedRequest,
    close: () => {
      authenticatedCloseCount += 1;
    },
  });
  const recoveryReadyDeadline = Date.now() + 5_000;
  while (clientRecovery.getState().status !== "ready" && Date.now() < recoveryReadyDeadline)
    await new Promise((resolveReady) => setTimeout(resolveReady, 10));
  const clientChat = "Sent by the real client recovery service over authenticated Team HTTP.";
  const clientTurnCompleted = waitForCompletedQueue(agent.id, clientChat);
  const clientRequestId = await clientRecovery.sendChat(target, clientChat);
  await clientTurnCompleted;
  await clientRecovery.recover();
  const clientConversation = await runCauseEffect(agents.readConversation(agent.id));
  pass(
    "real client recovery service accepts, consumes, and replays through the authenticated Host session",
    clientRecovery.getState().status === "ready" &&
      clientRequestId.length > 0 &&
      clientConversation.messages.some((message) => message.text === clientChat) &&
      authenticatedCalls.includes(`GET ${HOST_CHAT_RECOVERY_ROUTES.scope}`) &&
      authenticatedCalls.some((call) => call.startsWith(`GET ${HOST_CHAT_RECOVERY_ROUTES.events}`)) &&
      authenticatedCalls.includes(`POST ${HOST_CHAT_RECOVERY_ROUTES.accept}`) &&
      authenticatedCalls.includes(`POST ${HOST_CHAT_RECOVERY_ROUTES.consume}`),
  );
  await clientRecovery.activate(null);
  pass(
    "client runtime logout closes its authenticated Host session binding",
    clientRecovery.getState().status === "not-connected" && authenticatedCloseCount === 1,
  );

  report.passed = report.checks.every((check) => check.passed);
} finally {
  await clientRecovery?.dispose().catch(() => {});
  if (api) await Effect.runPromise(api.stop()).catch(() => {});
  await runCauseEffect(agents?.stop() ?? Effect.void).catch(() => {});
  database?.close();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const item of report.checks) process.stdout.write(`${item.passed ? "PASS" : "FAIL"} ${item.name}\n`);
  process.stdout.write(`Report: ${join(out, "report.json")}\n`);
  if (!report.passed) process.exitCode = 1;
}
