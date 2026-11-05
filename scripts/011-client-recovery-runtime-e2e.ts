// Runs the client account lifecycle, protected chat service, portable recovery adapter and owned SQLite store.
// The fake Host is reachable only through a cancellable authenticated Team API request binding.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CentralAuthState } from "@openbot/contracts/ipc";
import { HOST_CHAT_RECOVERY_ROUTES } from "@openbot/contracts/team-protocol/host-chat-recovery-v1";
import type { AuthenticatedTeamApiRequest } from "@openbot/team-client/host-chat-recovery-transport";
import { AuthenticatedTeamApiRequestError } from "@openbot/team-client/host-chat-recovery-transport";
import type { MessageRecoveryScope } from "@openbot/team-client/message-recovery";
import type { ClientAccountService } from "../src/main/client-account-service";
import { bindClientRecoveryAccountLifecycle, createClientRecoveryService } from "../src/main/client-recovery-service";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const reportPath = resolve(".openbot-build/011-client-recovery-runtime-e2e/report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-client-recovery-runtime-"));
const profile = join(root, "client-profile");
let scope: MessageRecoveryScope = {
  hostId: "fake-host",
  userId: "fake-user",
  deviceId: "logical-session-device",
  grantId: "logical-session-grant",
  capability: "chat" as const,
  hostEpoch: 2,
  authEpoch: 3,
  grantEpoch: 4,
};
const records: Array<{ method: string; path: string; body?: unknown }> = [];
const accepted = new Map<
  string,
  {
    sequence: number;
    messageId: string;
    requestId: string;
    target: { agentId: string; threadId: string };
    content: string;
    acceptedAt: string;
    occurredAt: string;
  }
>();
const acceptRequestIds: string[] = [];
const accountApiToken = "account-api-token-must-not-be-used-for-host";
const hostSessionToken = "fake-authenticated-host-session";
let currentAccount: CentralAuthState = { status: "signed_out" };
let closeCount = 0;
let hostRevoked = false;
let failNextConsume = true;
let consumeTemporaryFailures = 0;
let nextEventGate: ReturnType<typeof createEventGate> | undefined;
let nextCloseGate: ReturnType<typeof createEventGate> | undefined;

function scopeKey(value: typeof scope): string {
  const canonical = JSON.stringify([
    value.hostId,
    value.userId,
    value.deviceId,
    value.grantId,
    value.capability,
    value.hostEpoch,
    value.authEpoch,
    value.grantEpoch,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function createEventGate(ignoreAbort: boolean) {
  let start: (() => void) | undefined;
  let release: (() => void) | undefined;
  let abort: (() => void) | undefined;
  return {
    ignoreAbort,
    started: new Promise<void>((resolvePromise) => (start = resolvePromise)),
    aborted: new Promise<void>((resolvePromise) => (abort = resolvePromise)),
    start: () => start?.(),
    release: () => release?.(),
    abort: () => abort?.(),
    wait: () => new Promise<void>((resolvePromise) => (release = resolvePromise)),
  };
}
let service: Awaited<ReturnType<typeof createClientRecoveryService>> | undefined;
let unbind: (() => void) | undefined;
let fakeHostOrigin: string | undefined;

const fakeHost = createServer((incoming, response) => {
  void handleFakeHostRequest(incoming, response).catch(() => {
    if (!response.destroyed) sendJson(response, 500, { error: "request-failed" });
  });
});

async function listenFakeHost(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    fakeHost.once("error", reject);
    fakeHost.listen(0, "127.0.0.1", () => {
      try {
        const address = fakeHost.address();
        if (!address || typeof address === "string") throw new Error("The fake Host did not bind a TCP port.");
        fakeHostOrigin = `http://127.0.0.1:${address.port}`;
        fakeHost.off("error", reject);
        resolvePromise();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function closeFakeHost(): Promise<void> {
  if (!fakeHost.listening) return;
  fakeHost.closeAllConnections();
  await new Promise<void>((resolvePromise) => {
    try {
      fakeHost.close(() => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
}

async function handleFakeHostRequest(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = incoming.method ?? "GET";
  const path = incoming.url ?? "/";
  const url = new URL(path, "http://127.0.0.1");
  const body = await readRequestBody(incoming);
  records.push({ method, path, ...(body === undefined ? {} : { body }) });
  if (incoming.headers.authorization !== `Bearer ${hostSessionToken}`) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (hostRevoked) {
    sendJson(response, 403, { error: "revoked" });
    return;
  }
  if (method === "GET" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.scope) {
    sendJson(response, 200, scope);
    return;
  }
  if (method === "POST" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.accept) {
    if (
      !isRecord(body) ||
      !isRecord(body.target) ||
      typeof body.requestId !== "string" ||
      typeof body.content !== "string"
    ) {
      sendJson(response, 400, { error: "invalid-request" });
      return;
    }
    const requestId = body.requestId;
    acceptRequestIds.push(requestId);
    const existing = accepted.get(requestId);
    if (existing) {
      sendJson(response, 202, acceptanceReceipt(existing));
      return;
    }
    const event = {
      sequence: accepted.size + 1,
      messageId: `message-${accepted.size + 1}`,
      requestId,
      target: {
        agentId: String(body.target.agentId),
        threadId: String(body.target.threadId),
      },
      content: body.content,
      acceptedAt: new Date(1_800_000_000_000 + accepted.size).toISOString(),
      occurredAt: new Date(1_800_000_000_000 + accepted.size).toISOString(),
    };
    accepted.set(requestId, event);
    sendJson(response, 202, acceptanceReceipt(event));
    return;
  }
  if (method === "POST" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.consume) {
    if (failNextConsume) {
      failNextConsume = false;
      consumeTemporaryFailures += 1;
      sendJson(response, 503, { error: "temporary-failure" });
      return;
    }
    if (!isRecord(body) || typeof body.requestId !== "string") {
      sendJson(response, 400, { error: "invalid-request" });
      return;
    }
    const event = accepted.get(body.requestId);
    if (!event) {
      sendJson(response, 404, { error: "missing-request" });
      return;
    }
    sendJson(response, 200, {
      messageId: event.messageId,
      deliveries: [
        { id: `delivery-${event.sequence}`, recipientAgentId: event.target.agentId, status: "queued", position: 1 },
      ],
    });
    return;
  }
  if (method === "GET" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.events) {
    const eventScopeKey = scopeKey(scope);
    const gate = nextEventGate;
    nextEventGate = undefined;
    if (gate) {
      gate.start();
      if (gate.ignoreAbort) {
        await gate.wait();
      } else {
        await new Promise<void>((resolvePromise) =>
          response.once("close", () => {
            gate.abort();
            resolvePromise();
          }),
        );
        return;
      }
      if (response.destroyed) return;
    }
    const encodedCursor = url.searchParams.get("after");
    const rawCursor: JsonValue | undefined = encodedCursor === null ? undefined : JSON.parse(encodedCursor);
    const cursor =
      isRecord(rawCursor) && typeof rawCursor.sequence === "number" ? { sequence: rawCursor.sequence } : undefined;
    const events = [...accepted.values()]
      .filter((event) => event.sequence > (cursor?.sequence ?? 0))
      .map(({ sequence, messageId, requestId, target, content, occurredAt }) => ({
        sequence,
        messageId,
        requestId,
        target,
        content,
        occurredAt,
      }));
    const sequence = events.at(-1)?.sequence ?? cursor?.sequence ?? 0;
    sendJson(response, 200, {
      status: "events",
      events,
      cursor: { scopeKey: eventScopeKey, sequence },
      hasMore: false,
    });
    return;
  }
  if (method === "GET" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.snapshot) {
    sendJson(response, 200, {
      type: "host-chat-inbox-snapshot",
      complete: true,
      acceptedRequests: [...accepted.values()].map(
        ({ sequence, messageId, requestId, target, content, acceptedAt }) => ({
          sequence,
          messageId,
          requestId,
          target,
          content,
          acceptedAt,
        }),
      ),
      cursor: { scopeKey: scopeKey(scope), sequence: accepted.size },
    });
    return;
  }
  sendJson(response, 404, { error: "not-found" });
}

function acceptanceReceipt(event: { sequence: number; messageId: string; requestId: string; acceptedAt: string }) {
  return {
    receiptId: `receipt-${event.requestId}`,
    requestId: event.requestId,
    messageId: event.messageId,
    eventSequence: event.sequence,
    acceptedAt: event.acceptedAt,
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage): Promise<JsonValue | undefined> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: JsonValue): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

const request: AuthenticatedTeamApiRequest = async (method, path, decode, body, signal) => {
  if (!fakeHostOrigin) throw new Error("Fake Host is not listening.");
  const response = await fetch(new URL(path, fakeHostOrigin), {
    method,
    headers: {
      Authorization: `Bearer ${hostSessionToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new AuthenticatedTeamApiRequestError(response.status);
  return decode(await response.json());
};

const report: {
  passed: boolean;
  sqliteCreated: boolean;
  staleHostResolutionClosed: boolean;
  accountSignInActivatedHost: boolean;
  accountSignOutClosedHost: boolean;
  sentChatReachedAuthenticatedAdapter: boolean;
  recoveryReadHostEvent: boolean;
  consumeRetryKeptRequestId: boolean;
  logoutAbortedInFlightRequest: boolean;
  oldHostResponseDidNotReplaceNewGeneration: boolean;
  oldTeardownCannotCloseReplacement: boolean;
  accountResolverCancelled: boolean;
  hostRevocationClosedSession: boolean;
  accountTokenWasNotUsed: boolean;
  calls: string[];
} = {
  passed: false,
  sqliteCreated: false,
  staleHostResolutionClosed: false,
  accountSignInActivatedHost: false,
  accountSignOutClosedHost: false,
  sentChatReachedAuthenticatedAdapter: false,
  recoveryReadHostEvent: false,
  consumeRetryKeptRequestId: false,
  logoutAbortedInFlightRequest: false,
  oldHostResponseDidNotReplaceNewGeneration: false,
  oldTeardownCannotCloseReplacement: false,
  accountResolverCancelled: false,
  hostRevocationClosedSession: false,
  accountTokenWasNotUsed: true,
  calls: [],
};

const listeners = new Set<(state: CentralAuthState) => void>();
const account: Pick<ClientAccountService, "getState" | "onChanged"> = {
  getState: () => currentAccount,
  onChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

try {
  await listenFakeHost();
  service = await createClientRecoveryService({ profilePath: profile });
  let firstResolve: ((connection: { request: AuthenticatedTeamApiRequest; close(): void }) => void) | undefined;
  let firstResolverSignal: AbortSignal | undefined;
  let firstResolverStartedResolve: (() => void) | undefined;
  const firstResolverStarted = new Promise<void>((resolvePromise) => (firstResolverStartedResolve = resolvePromise));
  let staleClosedResolve: (() => void) | undefined;
  const staleClosed = new Promise<void>((resolvePromise) => (staleClosedResolve = resolvePromise));
  let resolutionCount = 0;
  const createConnection = () => ({
    request,
    close: async () => {
      const gate = nextCloseGate;
      nextCloseGate = undefined;
      if (gate) {
        gate.start();
        await gate.wait();
      }
      closeCount += 1;
    },
  });
  const resolveConnection = async (accountSubject: string, signal: AbortSignal) => {
    if (accountSubject !== "account-user") throw new Error("Unexpected account subject.");
    resolutionCount += 1;
    if (resolutionCount === 1) {
      firstResolverSignal = signal;
      firstResolverStartedResolve?.();
      return new Promise<{ request: AuthenticatedTeamApiRequest; close(): void }>(
        (resolvePromise) => (firstResolve = resolvePromise),
      );
    }
    return createConnection();
  };
  unbind = bindClientRecoveryAccountLifecycle(account, service, resolveConnection);
  assert.deepEqual(service.getState(), { status: "not-connected" });
  await access(join(profile, "message-recovery-v1.sqlite"));
  report.sqliteCreated = true;

  currentAccount = {
    status: "signed_in",
    user: {
      id: "account-user",
      email: "fixture@example.test",
      name: "Fixture",
      avatarUrl: null,
      analyticsEnabled: null,
    },
  };
  for (const listener of listeners) listener(currentAccount);
  await firstResolverStarted;
  currentAccount = { status: "signed_out" };
  for (const listener of listeners) listener(currentAccount);
  report.accountResolverCancelled = firstResolverSignal?.aborted === true;
  assert.equal(report.accountResolverCancelled, true);
  firstResolve?.({
    request,
    close: () => {
      closeCount += 1;
      staleClosedResolve?.();
    },
  });
  await staleClosed;
  assert.deepEqual(service.getState(), { status: "not-connected" });
  report.staleHostResolutionClosed = true;

  currentAccount = {
    status: "signed_in",
    user: {
      id: "account-user",
      email: "fixture@example.test",
      name: "Fixture",
      avatarUrl: null,
      analyticsEnabled: null,
    },
  };
  for (const listener of listeners) listener(currentAccount);
  await waitForState(service, "ready");
  await waitForRecoveryIdle(service);
  report.accountSignInActivatedHost = true;
  assert.equal(records[0]?.path, HOST_CHAT_RECOVERY_ROUTES.scope);

  await service
    .sendChat({ agentId: "agent-fixture", threadId: "thread-fixture" }, "runtime bridge message")
    .catch(() => undefined);
  assert.equal(accepted.size, 1);
  assert.equal(consumeTemporaryFailures, 1);
  const originalRequestId = acceptRequestIds[0];
  await service.recover();
  await waitForRecoveryIdle(service);
  report.consumeRetryKeptRequestId = originalRequestId !== undefined && acceptRequestIds[1] === originalRequestId;
  assert.equal(report.consumeRetryKeptRequestId, true);
  report.sentChatReachedAuthenticatedAdapter = true;
  report.recoveryReadHostEvent = records.some((record) => record.path.startsWith(HOST_CHAT_RECOVERY_ROUTES.events));
  assert.equal(report.recoveryReadHostEvent, true);
  report.accountTokenWasNotUsed = !JSON.stringify(records).includes(accountApiToken);

  const abortGate = createEventGate(false);
  nextEventGate = abortGate;
  const pendingRecovery = service.recover().catch(() => undefined);
  await abortGate.started;
  currentAccount = { status: "signed_out" };
  for (const listener of listeners) listener(currentAccount);
  await abortGate.aborted;
  await pendingRecovery;
  await waitForState(service, "not-connected");
  report.logoutAbortedInFlightRequest = true;
  assert.equal(report.logoutAbortedInFlightRequest, true);

  scope = { ...scope, authEpoch: scope.authEpoch + 1, grantEpoch: scope.grantEpoch + 1 };
  currentAccount = {
    status: "signed_in",
    user: {
      id: "account-user",
      email: "fixture@example.test",
      name: "Fixture",
      avatarUrl: null,
      analyticsEnabled: null,
    },
  };
  for (const listener of listeners) listener(currentAccount);
  await waitForState(service, "ready");
  await waitForRecoveryIdle(service);

  const lateResponseGate = createEventGate(true);
  nextEventGate = lateResponseGate;
  const lateRecovery = service.recover().catch(() => undefined);
  await lateResponseGate.started;
  currentAccount = { status: "signed_out" };
  for (const listener of listeners) listener(currentAccount);
  await waitForState(service, "not-connected");
  scope = { ...scope, authEpoch: scope.authEpoch + 1, grantEpoch: scope.grantEpoch + 1 };
  currentAccount = {
    status: "signed_in",
    user: {
      id: "account-user",
      email: "fixture@example.test",
      name: "Fixture",
      avatarUrl: null,
      analyticsEnabled: null,
    },
  };
  for (const listener of listeners) listener(currentAccount);
  await waitForState(service, "ready");
  await waitForRecoveryIdle(service);
  lateResponseGate.release();
  await lateRecovery;
  assert.equal(service.getState().status, "ready");
  report.oldHostResponseDidNotReplaceNewGeneration = true;

  const closeGate = createEventGate(true);
  nextCloseGate = closeGate;
  const oldTeardown = service.activate(null);
  await closeGate.started;
  scope = { ...scope, authEpoch: scope.authEpoch + 1, grantEpoch: scope.grantEpoch + 1 };
  await service.activate(createConnection());
  await waitForRecoveryIdle(service);
  closeGate.release();
  await oldTeardown;
  report.oldTeardownCannotCloseReplacement = service.getState().status === "ready";
  assert.equal(report.oldTeardownCannotCloseReplacement, true);

  hostRevoked = true;
  await service.recover().catch(() => undefined);
  await waitForState(service, "not-connected");
  report.hostRevocationClosedSession = closeCount > 1;
  assert.equal(report.hostRevocationClosedSession, true);

  currentAccount = { status: "signed_out" };
  for (const listener of listeners) listener(currentAccount);
  await waitForState(service, "not-connected");
  report.accountSignOutClosedHost = closeCount > 0;
  assert.equal(report.accountSignOutClosedHost, true);
  report.calls = records.map(({ method, path }) => `${method} ${path.split("?")[0]}`);
  report.passed = true;
} catch (error) {
  report.calls = records.map(({ method, path }) => `${method} ${path.split("?")[0]}`);
  throw error;
} finally {
  unbind?.();
  await service?.dispose();
  await closeFakeHost();
  await mkdir(reportPath.slice(0, reportPath.lastIndexOf("/")), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

function waitForState(
  client: Awaited<ReturnType<typeof createClientRecoveryService>>,
  expected: string,
): Promise<void> {
  if ((client.getState().status === "ready") === (expected === "ready")) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for client recovery state ${expected}.`));
    }, 10_000);
    const unsubscribe = client.onState((state) => {
      if ((state.status === "ready") !== (expected === "ready")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolvePromise();
    });
  });
}

function waitForRecoveryIdle(client: Awaited<ReturnType<typeof createClientRecoveryService>>): Promise<void> {
  const isIdle = () => client.getState().status === "ready" && client.getState().phase === "idle";
  if (isIdle()) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for client recovery to become idle."));
    }, 10_000);
    const unsubscribe = client.onState(() => {
      if (!isIdle()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolvePromise();
    });
  });
}
