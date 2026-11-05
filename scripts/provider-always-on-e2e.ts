// Exercises ProviderRuntime through the real Codex app-server and Antigravity ACP paths, with fake
// provider subprocesses and no live OAuth or model calls. Writes a machine-readable lifecycle report.
// `node --import tsx scripts/provider-always-on-e2e.ts` runs the native Node stream path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import type { AgentProvider } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import { ANTIGRAVITY_MANIFEST, parseCodexVersion, resolveCodexCli } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { decodeRecordResponse, decodeThreadResponse } from "../src/backend/protocol";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import {
  type ProviderLifecycleMode,
  providerLifecycleModeFor,
  readProviderLifecycleMode,
} from "../src/backend/provider-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-always-on-e2e");
const FAKE_VERSION = "1.2.1";
const FAKE_CODEX_VERSION = "0.156.0";
const PROVIDER_IDLE_CHECK_MS = 5;
const PROVIDER_IDLE_RELEASE_MS = 1_800;
const SESSION_IDLE_RELEASE_MS = 5_000;
const execFileAsync = promisify(execFile);

const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const NL = String.fromCharCode(10);
const sessions = new Map();
let nextSession = 0;
const control = () => JSON.parse(fs.readFileSync(process.env.FAKE_AGY_CONTROL, "utf8"));
const setControl = (value) => fs.writeFileSync(process.env.FAKE_AGY_CONTROL, JSON.stringify(value));
const log = (entry) => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({
  provider: "antigravity",
  case: process.env.FAKE_AGY_CASE,
  pid: process.pid,
  at: Date.now(),
  ...entry,
}) + NL);
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + NL);
process.on("exit", () => log({ method: "process-exit" }));
process.on("SIGTERM", () => {
  log({ method: "process-signal", signal: "SIGTERM" });
  process.exit(0);
});
log({
  method: "process-start",
  argv: process.argv.slice(1),
  execPath: process.execPath,
  bunVersion: process.versions.bun ?? null,
  tempDirectory: process.env.TMP ?? null,
  previousTempExists: control().lastTempDirectory ? fs.existsSync(control().lastTempDirectory) : false,
});
if (process.env.TMP) {
  const state = control();
  state.lastTempDirectory = process.env.TMP;
  setControl(state);
}
function handle(message) {
  const params = message.params ?? {};
  log({ method: "request-received", requestMethod: message.method });
  if (message.id === undefined) {
    log({ method: message.method, sessionId: params.sessionId ?? null });
    return;
  }
  if (message.method === "initialize") {
    const state = control();
    if ((state.withholdRemaining ?? 0) > 0) {
      state.withholdRemaining -= 1;
      setControl(state);
      log({ method: "initialize-withheld" });
      return;
    }
    if (state.initializeBehavior === "withhold") return;
    if (state.initializeBehavior === "auth")
      return write({ id: message.id, error: { code: 401, message: "unauthorized" } });
    if (state.initializeBehavior === "unknown")
      return write({ id: message.id, error: { code: -32600, message: "invalid request" } });
    return write({ id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      authMethods: [],
    } });
  }
  if (message.method === "session/new") {
    const sessionId = "session-" + process.pid + "-" + (++nextSession);
    sessions.set(sessionId, params.cwd ?? null);
    log({ method: message.method, sessionId, cwd: params.cwd ?? null });
    return write({ id: message.id, result: {
      sessionId,
      models: { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" },
    } });
  }
  if (message.method === "session/prompt") {
    const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
    log({ method: message.method, sessionId: params.sessionId, text });
    write({ method: "session/update", params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    } });
    return write({ id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") {
    log({ method: message.method, sessionId: params.sessionId, cwd: sessions.get(params.sessionId) ?? null });
    sessions.delete(params.sessionId);
    return write({ id: message.id, result: {} });
  }
  if (message.method === "session/resume" || message.method === "session/load") {
    sessions.set(params.sessionId, params.cwd ?? null);
    log({ method: message.method, sessionId: params.sessionId, cwd: params.cwd ?? null });
    return write({ id: message.id, result: {
      sessionId: params.sessionId,
      models: { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" },
    } });
  }
  return write({ id: message.id, result: {} });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  log({ method: "stdin-data", byteLength: chunk.length, containsLineBreak: chunk.includes(NL) });
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  log({ method: "stdin-end" });
  process.exit(0);
});
`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const control = () => JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_CONTROL, "utf8"));
const setControl = (value) => fs.writeFileSync(process.env.FAKE_CODEX_CONTROL, JSON.stringify(value));
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  provider: "codex",
  case: process.env.FAKE_CODEX_CASE,
  pid: process.pid,
  at: Date.now(),
  ...entry,
}) + NL);
if (argv[0] === "--version") {
  log({
    method: "version-probe",
    argv: process.argv.slice(1),
    execPath: process.execPath,
    bunVersion: process.versions.bun ?? null,
  });
  process.stdout.write("codex-cli ${FAKE_CODEX_VERSION}" + NL, () => process.exit(0));
} else {
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + NL);
process.on("exit", () => log({ method: "process-exit" }));
process.on("SIGTERM", () => {
  log({ method: "process-signal", signal: "SIGTERM" });
  process.exit(0);
});
log({
  method: "process-start",
  argv: process.argv.slice(1),
  execPath: process.execPath,
  bunVersion: process.versions.bun ?? null,
});
function handle(message) {
  log({ method: "request-received", requestMethod: message.method ?? null });
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    const state = control();
    if ((state.withholdRemaining ?? 0) > 0) {
      state.withholdRemaining -= 1;
      setControl(state);
      log({ method: "initialize-withheld" });
      return;
    }
    if (state.initializeBehavior === "withhold") return;
    if (state.initializeBehavior === "auth")
      return write({ id: message.id, error: { code: 401, message: "unauthorized" } });
    if (state.initializeBehavior === "unknown")
      return write({ id: message.id, error: { code: -32600, message: "invalid request" } });
    return write({ id: message.id, result: {} });
  }
  if (message.method === "account/read")
    return write({ id: message.id, result: {
      account: { type: "chatgpt", email: "codex-fixture@example.test", planType: "plus" },
      requiresOpenaiAuth: false,
    } });
  if (message.method === "model/list") return write({ id: message.id, result: { data: [] } });
  if (message.method === "account/rateLimits/read") return write({ id: message.id, result: {} });
  return write({ id: message.id, result: {} });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => log({ method: "stdin-end" }));
}
`;

interface LogEntry {
  provider?: "antigravity" | "codex";
  case: string;
  pid: number;
  method: string;
  signal?: string;
  argv?: string[];
  execPath?: string;
  bunVersion?: string | null;
  tempDirectory?: string | null;
  previousTempExists?: boolean;
  at?: number;
  requestMethod?: string;
  byteLength?: number;
  containsLineBreak?: boolean;
  sessionId?: string | null;
  cwd?: string | null;
  text?: string;
}

interface Report {
  passed: boolean;
  validation: {
    runPlatform: NodeJS.Platform;
    hostRuntime: "bun" | "node";
    nodeVersion: string;
    antigravityDriver: "real-driver-fake-acp-subprocess";
    codexAppServer: "real-driver-fake-app-server-subprocess";
    surfacePro7WindowsTarget: "not-tested";
    liveOAuth: "not-tested";
    liveModelCalls: "not-tested";
  };
  failure?: string;
  providerEvents?: LogEntry[];
  codexCliProbe?: {
    argv: string[];
    stdout: string;
    stderr: string;
    parsedVersion?: string;
    resolvedVersion?: string;
    resolutionFailure?: string;
  };
  config?: {
    unset: ProviderLifecycleMode;
    desktop: ProviderLifecycleMode;
    alwaysOn: ProviderLifecycleMode;
    nonTargetProvider: ProviderLifecycleMode;
    invalidValueRedacted: boolean;
  };
  protocolRequests?: { antigravity: string[]; codex: string[] };
  desktopCapacityReleased?: boolean;
  desktopCapacityReleaseObservedBeforeIdleTimeout?: boolean;
  nativeSessionIdsMatched?: { desktop: boolean; alwaysOn: boolean };
  alwaysOnSessionRetained?: boolean;
  desktopProviderReleased?: boolean;
  alwaysOnProviderRetained?: boolean;
  desktopCodexProviderReleased?: boolean;
  alwaysOnCodexProviderRetained?: boolean;
  memoryPressureReleasedSession?: boolean;
  memoryPressureKeptProvider?: boolean;
  memoryPressureResumePreservedNativeSessionId?: boolean;
  explicitStopEndedProvider?: boolean;
  explicitStopEndedCodexProvider?: boolean;
  initializationRetry?: {
    codexRecovered: boolean;
    antigravityRecovered: boolean;
    increasingBackoffObserved: boolean;
    longRunningWarningShown: boolean;
    authRefusalDidNotRetry: boolean;
    unknownRefusalDidNotRetry: boolean;
    diskRefusalDidNotLaunch: boolean;
    budgetStoppedAtLimit: number;
    explicitRefreshResetBudget: boolean;
    disposeCancelledRetry: boolean;
    antigravityTempRemovedBeforeRetry: boolean;
    maxConcurrentRetryProcesses: number;
  };
}

const root = await mkdtemp(join(tmpdir(), "openbot-provider-always-on-e2e-"));
const logPath = join(root, "agy.log");
const codexLogPath = join(root, "codex.log");
const executable = join(root, "agy", "bin", "agy_acp_server");
const codexExecutable = join(root, "codex", "bin", "codex");
const agyControlPath = join(root, "agy-control.json");
const codexControlPath = join(root, "codex-control.json");
const priorCodexPath = process.env.OPENBOT_CODEX_PATH;
const report: Report = {
  passed: false,
  validation: {
    runPlatform: process.platform,
    hostRuntime: process.versions.bun ? "bun" : "node",
    nodeVersion: process.versions.node,
    antigravityDriver: "real-driver-fake-acp-subprocess",
    codexAppServer: "real-driver-fake-app-server-subprocess",
    surfacePro7WindowsTarget: "not-tested",
    liveOAuth: "not-tested",
    liveModelCalls: "not-tested",
  },
};
const reportPath = join(OUT, "report.json");
process.env.FAKE_AGY_LOG = logPath;
process.env.FAKE_CODEX_LOG = codexLogPath;
process.env.FAKE_AGY_CONTROL = agyControlPath;
process.env.FAKE_CODEX_CONTROL = codexControlPath;

async function logEntries(): Promise<LogEntry[]> {
  try {
    return (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line): LogEntry => JSON.parse(line));
  } catch {
    return [];
  }
}

async function codexLogEntries(): Promise<LogEntry[]> {
  try {
    return (await readFile(codexLogPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line): LogEntry => JSON.parse(line));
  } catch {
    return [];
  }
}

type ProviderControl = {
  withholdRemaining?: number;
  initializeBehavior?: "withhold" | "auth" | "unknown";
  lastTempDirectory?: string | null;
};

async function setProviderControl(provider: AgentProvider, state: ProviderControl): Promise<void> {
  await writeFile(provider === "antigravity" ? agyControlPath : codexControlPath, JSON.stringify(state));
}

async function providerEvents(provider: AgentProvider, caseName: string): Promise<LogEntry[]> {
  const entries = provider === "antigravity" ? await logEntries() : await codexLogEntries();
  return entries.filter((entry) => entry.provider === provider && entry.case === caseName);
}

function maximumConcurrentProcesses(entries: readonly LogEntry[]): number {
  const running = new Set<number>();
  let maximum = 0;
  for (const entry of entries) {
    if (entry.method === "process-start") {
      running.add(entry.pid);
      maximum = Math.max(maximum, running.size);
    } else if (entry.method === "process-exit") {
      running.delete(entry.pid);
    }
  }
  return maximum;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a process or runtime state transition. The deadline only bounds a failed check. */
async function waitFor<T>(
  label: string,
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resume) => setTimeout(resume, 10));
  }
}

async function installFakeAcp(): Promise<void> {
  await mkdir(join(root, "agy", "bin"), { recursive: true });
  await writeFile(join(root, "agy", ANTIGRAVITY_MANIFEST), JSON.stringify({ version: FAKE_VERSION }));
  await writeFile(executable, FAKE_AGY);
  await chmod(executable, 0o755);
}

async function installFakeCodex(): Promise<void> {
  await mkdir(join(root, "codex", "bin"), { recursive: true });
  await writeFile(codexExecutable, FAKE_CODEX);
  await chmod(codexExecutable, 0o755);
}

const database = new OpenBotDatabase(join(root, "profile"));
const store = new AgentStore(join(root, "profile"), join(root, "home"), database);
const conversation = new ConversationRuntime(
  store,
  () => undefined,
  () => store.list(),
);
const offProviders = BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter(
  (provider) => provider !== "antigravity" && provider !== "codex",
);
const runtimes = new Map<ProviderLifecycleMode, ProviderRuntime>();
const directProviderActivity = new WeakMap<ProviderRuntime, Set<AgentProvider>>();
type RuntimeHarnessOptions = {
  onlyProvider?: AgentProvider;
  caseName?: string;
  requestTimeoutMs?: number;
  retryPolicy?: ConstructorParameters<typeof ProviderRuntime>[0]["testInitializationRetryPolicy"];
  availableDiskBytes?: (path: string) => number;
};

function createRuntime(mode: ProviderLifecycleMode, harness: RuntimeHarnessOptions = {}): ProviderRuntime {
  const busyProviders = new Set<AgentProvider>();
  const providers = new ProviderRuntime({
    offProviders: harness.onlyProvider
      ? BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter((provider) => provider !== harness.onlyProvider)
      : offProviders,
    conversation,
    hooks: {
      bindClient: () => undefined,
      onProvidersReady: () => Effect.void,
      onProviderLost: () => undefined,
      onClientStopped: () => Effect.void,
      isStopping: () => false,
      isProviderBusy: (provider) => busyProviders.has(provider),
      isAgentBusy: () => false,
      isProviderAssigned: () => true,
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: () => undefined,
    requestTimeoutMs: harness.requestTimeoutMs ?? 5_000,
    longStartTimeoutMs: harness.requestTimeoutMs ?? 5_000,
    ...(harness.retryPolicy ? { testInitializationRetryPolicy: harness.retryPolicy } : {}),
    providerLifecycleMode: mode,
    providerIdleCheckMs: PROVIDER_IDLE_CHECK_MS,
    providerIdleReleaseMs: PROVIDER_IDLE_RELEASE_MS,
    providerUnassignedReleaseMs: PROVIDER_IDLE_RELEASE_MS,
    providerSessionIdleReleaseMs: SESSION_IDLE_RELEASE_MS,
    preferredProvider: "antigravity",
    clientFactory: null,
    bundledExecutables: { antigravity: executable, codex: codexExecutable },
    credentials: {
      ...NO_PROVIDER_CREDENTIALS,
      agentEnvironment: () => ({ FAKE_AGY_CASE: harness.caseName ?? mode, FAKE_AGY_CONTROL: agyControlPath }),
      serverEnvironment: { FAKE_CODEX_CASE: harness.caseName ?? mode, FAKE_CODEX_CONTROL: codexControlPath },
      providerTempDirectory: join(root, "provider-temp"),
      ...(harness.availableDiskBytes ? { availableDiskBytes: harness.availableDiskBytes } : {}),
    },
    redactMcp: (text) => text,
  });
  directProviderActivity.set(providers, busyProviders);
  runtimes.set(mode, providers);
  return providers;
}

async function withProviderBusy<T>(
  providers: ProviderRuntime,
  provider: AgentProvider,
  run: () => Promise<T>,
): Promise<T> {
  const busy = directProviderActivity.get(providers);
  assert.ok(busy, "the provider runtime has its direct-request activity state");
  busy.add(provider);
  try {
    return await run();
  } finally {
    busy.delete(provider);
  }
}

function threadSessionPid(entries: LogEntry[], mode: ProviderLifecycleMode, cwd: string): number | null {
  return (
    entries.find((entry) => entry.case === mode && entry.method === "session/new" && entry.cwd === cwd)?.pid ?? null
  );
}

function isThreadReleased(entries: LogEntry[], mode: ProviderLifecycleMode, cwd: string): boolean {
  const pid = threadSessionPid(entries, mode, cwd);
  return entries.some(
    (entry) =>
      entry.case === mode &&
      ((entry.method === "session/close" && entry.cwd === cwd) ||
        (pid !== null && ["process-exit", "process-signal"].includes(entry.method) && entry.pid === pid)),
  );
}

async function startThreadTurn(mode: ProviderLifecycleMode, providers: ProviderRuntime, cwd: string): Promise<string> {
  return withProviderBusy(providers, "antigravity", async () => {
    const client = providers.currentClient("antigravity");
    assert.ok(client, `${mode} Antigravity client starts`);
    const thread = await runCauseEffect(
      client.request(
        "thread/start",
        { cwd, model: "gemini-fake", dynamicTools: [], runtimeWorkspaceRoots: [] },
        decodeThreadResponse,
      ),
    );
    let turnCompleted = false;
    const onNotification = (notification: { method: string; params?: unknown }) => {
      if (notification.method !== "turn/completed") return;
      if (notification.params && typeof notification.params === "object" && "threadId" in notification.params) {
        if (notification.params.threadId === thread.thread.id) turnCompleted = true;
      }
    };
    client.on("notification", onNotification);
    try {
      await runCauseEffect(
        client.request(
          "turn/start",
          { threadId: thread.thread.id, model: "gemini-fake", input: [{ type: "text", text: "Check the session." }] },
          decodeRecordResponse,
        ),
      );
      await waitFor(`${mode} ACP turn completion`, async () => turnCompleted);
      return thread.thread.id;
    } finally {
      client.off("notification", onNotification);
    }
  });
}

async function continueThreadTurn(
  mode: ProviderLifecycleMode,
  providers: ProviderRuntime,
  threadId: string,
): Promise<void> {
  await withProviderBusy(providers, "antigravity", async () => {
    const client = providers.currentClient("antigravity");
    assert.ok(client, `${mode} Antigravity client remains running`);
    let turnCompleted = false;
    const onNotification = (notification: { method: string; params?: unknown }) => {
      if (
        notification.method === "turn/completed" &&
        notification.params &&
        typeof notification.params === "object" &&
        "threadId" in notification.params &&
        notification.params.threadId === threadId
      )
        turnCompleted = true;
    };
    client.on("notification", onNotification);
    try {
      await runCauseEffect(
        client.request(
          "turn/start",
          { threadId, model: "gemini-fake", input: [{ type: "text", text: "Resume the same session." }] },
          decodeRecordResponse,
        ),
      );
      await waitFor(`${mode} resumed ACP turn completion`, async () => turnCompleted);
    } finally {
      client.off("notification", onNotification);
    }
  });
}

async function stopRuntime(providers: ProviderRuntime): Promise<void> {
  const clients = await runCauseEffect(providers.dispose());
  await Promise.all(clients.map((client) => runCauseEffect(client.stop())));
  providers.markStopped();
}

function retryPolicyOverrides(
  options: {
    launchLimit?: number;
    warningAfterMs?: number;
    diskSpaceCheckMs?: number;
    delayMs?: number;
    initialDelaysMs?: readonly number[];
    maxDelayMs?: number;
  } = {},
): NonNullable<RuntimeHarnessOptions["retryPolicy"]> {
  const delayMs = options.delayMs ?? 35;
  return {
    initialDelaysMs: options.initialDelaysMs ?? [delayMs, delayMs, delayMs],
    maxDelayMs: options.maxDelayMs ?? Math.max(delayMs, 150),
    warningAfterMs: options.warningAfterMs ?? 5_000,
    diskSpaceCheckMs: options.diskSpaceCheckMs ?? delayMs,
    launchLimit: options.launchLimit ?? 6,
    jitter: (delay) => delay,
  };
}

async function providerStartCount(provider: AgentProvider, caseName: string): Promise<number> {
  const entries = await providerEvents(provider, caseName);
  return entries.filter((entry) => entry.method === "process-start").length;
}

async function waitForProviderState(
  runtime: ProviderRuntime,
  provider: AgentProvider,
  expected: "available" | "sign-in-required" | "error",
): Promise<void> {
  await waitFor(`${provider} ${expected} state`, async () => {
    const state = runtime.status().providers?.find((row) => row.id === provider)?.state;
    return state === expected ? state : null;
  });
}

function providerMessage(runtime: ProviderRuntime, provider: AgentProvider): string | null {
  return runtime.status().providers?.find((row) => row.id === provider)?.message ?? null;
}

try {
  await writeFile(agyControlPath, JSON.stringify({}));
  await writeFile(codexControlPath, JSON.stringify({}));
  await runCauseEffect(store.initialize());
  const config = {
    unset: readProviderLifecycleMode({}),
    desktop: readProviderLifecycleMode({ OPENBOT_PROVIDER_LIFECYCLE: "desktop" }),
    alwaysOn: readProviderLifecycleMode({ OPENBOT_PROVIDER_LIFECYCLE: "always-on" }),
    nonTargetProvider: providerLifecycleModeFor("claude", "always-on"),
    invalidValueRedacted: false,
  };
  report.config = config;
  assert.equal(config.unset, "desktop");
  assert.equal(config.desktop, "desktop");
  assert.equal(config.alwaysOn, "always-on");
  assert.equal(config.nonTargetProvider, "desktop");
  assert.throws(
    () => readProviderLifecycleMode({ OPENBOT_PROVIDER_LIFECYCLE: "secret-invalid-value" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /OPENBOT_PROVIDER_LIFECYCLE/u);
      assert.doesNotMatch(error.message, /secret-invalid-value/u);
      config.invalidValueRedacted = true;
      return true;
    },
  );

  await installFakeAcp();
  await installFakeCodex();
  process.env.OPENBOT_CODEX_PATH = codexExecutable;
  const codexVersionProbe = await execFileAsync(codexExecutable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  report.codexCliProbe = {
    argv: [codexExecutable, "--version"],
    stdout: codexVersionProbe.stdout.trim(),
    stderr: codexVersionProbe.stderr.trim(),
  };
  assert.equal(codexVersionProbe.stdout.trim(), `codex-cli ${FAKE_CODEX_VERSION}`);
  const parsedCodexVersion = parseCodexVersion(codexVersionProbe.stdout);
  report.codexCliProbe.parsedVersion = parsedCodexVersion;
  assert.equal(parsedCodexVersion, FAKE_CODEX_VERSION);
  try {
    const resolved = await runCauseEffect(
      resolveCodexCli({ systemCandidates: [codexExecutable], bundledExecutable: null }),
    );
    report.codexCliProbe.resolvedVersion = resolved.version;
    assert.equal(resolved.executable, codexExecutable);
    assert.equal(resolved.version, FAKE_CODEX_VERSION);
  } catch (error) {
    report.codexCliProbe.resolutionFailure = error instanceof Error ? error.message : String(error);
    throw error;
  }
  const desktopWorkspaces = [1, 2, 3, 4].map((index) => join(root, `desktop-workspace-${index}`));
  const alwaysOnWorkspaces = [1, 2, 3].map((index) => join(root, `always-on-workspace-${index}`));
  await Promise.all([...desktopWorkspaces, ...alwaysOnWorkspaces].map((path) => mkdir(path, { recursive: true })));
  const desktop = createRuntime("desktop");
  const alwaysOn = createRuntime("always-on");
  const runtimeStarts = await Promise.allSettled([runCauseEffect(desktop.start()), runCauseEffect(alwaysOn.start())]);
  const runtimeStartFailure = runtimeStarts.find((result) => result.status === "rejected");
  if (runtimeStartFailure?.status === "rejected") throw runtimeStartFailure.reason;
  const providerStarts = await Promise.allSettled([
    runCauseEffect(desktop.ensureProvider("codex")),
    runCauseEffect(desktop.ensureProvider("antigravity")),
    runCauseEffect(alwaysOn.ensureProvider("codex")),
    runCauseEffect(alwaysOn.ensureProvider("antigravity")),
  ]);
  const providerStartFailure = providerStarts.find((result) => result.status === "rejected");
  if (providerStartFailure?.status === "rejected") throw providerStartFailure.reason;
  assert.equal(desktop.status().providers?.find((provider) => provider.id === "codex")?.state, "available");
  assert.equal(alwaysOn.status().providers?.find((provider) => provider.id === "codex")?.state, "available");
  assert.equal(desktop.status().providers?.find((provider) => provider.id === "antigravity")?.state, "available");
  assert.equal(alwaysOn.status().providers?.find((provider) => provider.id === "antigravity")?.state, "available");

  const protocolRequests = await waitFor("fixture provider initialization and model discovery", async () => {
    const antigravity = await logEntries();
    const codex = await codexLogEntries();
    const antigravityRequests = antigravity.flatMap((entry) =>
      entry.method === "request-received" && entry.requestMethod ? [entry.requestMethod] : [],
    );
    const codexRequests = codex.flatMap((entry) =>
      entry.method === "request-received" && entry.requestMethod ? [entry.requestMethod] : [],
    );
    if (
      antigravityRequests.includes("initialize") &&
      antigravityRequests.includes("session/new") &&
      codexRequests.includes("initialize") &&
      codexRequests.includes("account/read") &&
      codexRequests.includes("model/list")
    )
      return { antigravity: antigravityRequests, codex: codexRequests };
    return null;
  });
  report.protocolRequests = protocolRequests;
  assert.ok(protocolRequests.antigravity.includes("initialize"), "Antigravity receives the ACP initialize request");
  assert.ok(protocolRequests.antigravity.includes("session/new"), "Antigravity performs ACP model discovery");
  assert.ok(protocolRequests.codex.includes("initialize"), "Codex receives the app-server initialize request");
  assert.ok(protocolRequests.codex.includes("account/read"), "Codex reads the fixture account without OAuth");
  assert.ok(protocolRequests.codex.includes("model/list"), "Codex performs app-server model discovery");

  const desktopThreadIds: string[] = [];
  const alwaysOnThreadIds: string[] = [];
  let firstDesktopTurnCompletedAt = 0;
  for (const [index, cwd] of desktopWorkspaces.entries()) {
    desktopThreadIds.push(await startThreadTurn("desktop", desktop, cwd));
    if (index === 0) firstDesktopTurnCompletedAt = Date.now();
    await runCauseEffect(desktop.ensureProvider("antigravity"));
    if (index === desktopWorkspaces.length - 1) {
      const remainingBeforeTimeout = SESSION_IDLE_RELEASE_MS - (Date.now() - firstDesktopTurnCompletedAt);
      assert.ok(remainingBeforeTimeout > 0, "desktop capacity evidence is collected before the idle timeout");
      const oldestWorkspace = desktopWorkspaces[0];
      assert.ok(oldestWorkspace);
      await waitFor(
        "desktop capacity release of the oldest idle session before the idle timeout",
        async () => {
          const entries = await logEntries();
          return isThreadReleased(entries, "desktop", oldestWorkspace);
        },
        remainingBeforeTimeout,
      );
      report.desktopCapacityReleased = true;
      report.desktopCapacityReleaseObservedBeforeIdleTimeout =
        Date.now() - firstDesktopTurnCompletedAt < SESSION_IDLE_RELEASE_MS;
      assert.ok(
        report.desktopCapacityReleaseObservedBeforeIdleTimeout,
        "the fourth desktop session causes capacity release before the idle timer can fire",
      );
    }
  }
  for (const cwd of alwaysOnWorkspaces) {
    alwaysOnThreadIds.push(await startThreadTurn("always-on", alwaysOn, cwd));
    await runCauseEffect(alwaysOn.ensureProvider("antigravity"));
  }
  assert.equal(desktopThreadIds.length, desktopWorkspaces.length);
  assert.equal(alwaysOnThreadIds.length, alwaysOnWorkspaces.length);

  const afterDesktopClose = await logEntries();
  report.nativeSessionIdsMatched = {
    desktop: desktopThreadIds.every((id) =>
      afterDesktopClose.some(
        (entry) => entry.case === "desktop" && entry.method === "session/new" && entry.sessionId === id,
      ),
    ),
    alwaysOn: alwaysOnThreadIds.every((id) =>
      afterDesktopClose.some(
        (entry) => entry.case === "always-on" && entry.method === "session/new" && entry.sessionId === id,
      ),
    ),
  };
  assert.ok(report.nativeSessionIdsMatched.desktop, "desktop thread IDs match Antigravity native session IDs");
  assert.ok(report.nativeSessionIdsMatched.alwaysOn, "always-on thread IDs match Antigravity native session IDs");
  report.alwaysOnSessionRetained = alwaysOnWorkspaces.every(
    (cwd) => !isThreadReleased(afterDesktopClose, "always-on", cwd),
  );
  assert.ok(report.alwaysOnSessionRetained, "always-on retains its idle ACP sessions after desktop capacity release");

  await waitFor("desktop provider idle release", async () => desktop.currentClient("antigravity") === null);
  report.desktopProviderReleased = true;
  report.alwaysOnProviderRetained = alwaysOn.currentClient("antigravity")?.running === true;
  assert.ok(report.alwaysOnProviderRetained, "always-on retains its provider process after the desktop timer fires");
  report.desktopCodexProviderReleased = desktop.currentClient("codex") === null;
  assert.ok(report.desktopCodexProviderReleased, "desktop releases the idle Codex app-server process");
  report.alwaysOnCodexProviderRetained = alwaysOn.currentClient("codex")?.running === true;
  assert.ok(report.alwaysOnCodexProviderRetained, "always-on retains the idle Codex app-server process");

  await runCauseEffect(alwaysOn.releaseIdleThreads());
  await waitFor("always-on memory-pressure release", async () => {
    const entries = await logEntries();
    return alwaysOnWorkspaces.every((cwd) => isThreadReleased(entries, "always-on", cwd));
  });
  report.memoryPressureReleasedSession = true;
  report.memoryPressureKeptProvider = alwaysOn.currentClient("antigravity")?.running === true;
  assert.ok(
    report.memoryPressureKeptProvider,
    "memory pressure can close an idle session while keeping the host provider running",
  );

  const restoredThreadId = alwaysOnThreadIds[0];
  const restoredWorkspace = alwaysOnWorkspaces[0];
  assert.ok(restoredThreadId && restoredWorkspace);
  await continueThreadTurn("always-on", alwaysOn, restoredThreadId);
  const afterMemoryPressureResume = await logEntries();
  report.memoryPressureResumePreservedNativeSessionId = afterMemoryPressureResume.some(
    (entry) =>
      entry.case === "always-on" &&
      entry.method === "session/load" &&
      entry.sessionId === restoredThreadId &&
      entry.cwd === restoredWorkspace,
  );
  assert.ok(
    report.memoryPressureResumePreservedNativeSessionId,
    "memory pressure restores the original Antigravity session ID for its next turn",
  );

  await stopRuntime(alwaysOn);
  report.explicitStopEndedProvider =
    alwaysOn.currentClient("antigravity") === null &&
    (
      await waitFor("explicit stop of the always-on provider process", async () => {
        const entries = await logEntries();
        return entries.find((entry) => entry.case === "always-on" && entry.method === "process-exit");
      })
    ).method === "process-exit";
  assert.ok(report.explicitStopEndedProvider, "an explicit runtime stop ends the always-on provider");
  report.explicitStopEndedCodexProvider =
    alwaysOn.currentClient("codex") === null &&
    (
      await waitFor("explicit stop of the always-on Codex process", async () => {
        const entries = await codexLogEntries();
        return entries.find((entry) => entry.case === "always-on" && entry.method === "process-exit");
      })
    ).method === "process-exit";
  assert.ok(report.explicitStopEndedCodexProvider, "an explicit runtime stop ends the always-on Codex process");

  const recoveryPolicy = retryPolicyOverrides({ delayMs: 40, launchLimit: 4 });
  async function recoverAfterInitializationTimeout(provider: AgentProvider, caseName: string) {
    await setProviderControl(provider, { withholdRemaining: 1, lastTempDirectory: null });
    const runtime = createRuntime("always-on", {
      onlyProvider: provider,
      caseName,
      requestTimeoutMs: 250,
      retryPolicy: recoveryPolicy,
    });
    await runCauseEffect(runtime.start());
    await waitForProviderState(runtime, provider, "available");
    const events = await providerEvents(provider, caseName);
    const starts = events.filter((entry) => entry.method === "process-start");
    assert.equal(starts.length, 2, `${provider} retries a withheld initialize once, then recovers`);
    const maximum = maximumConcurrentProcesses(events);
    assert.equal(maximum, 1, `${provider} never overlaps its timed-out and replacement processes`);
    let tempRemovedBeforeRetry = true;
    if (provider === "antigravity") {
      const secondStart = starts[1];
      const firstTemp = starts[0]?.tempDirectory;
      tempRemovedBeforeRetry =
        secondStart?.previousTempExists === false &&
        firstTemp !== undefined &&
        firstTemp !== null &&
        !(await pathExists(firstTemp));
      assert.ok(tempRemovedBeforeRetry, "Antigravity temp cleanup completes before its retry launches");
    }
    await stopRuntime(runtime);
    return { maximum, tempRemovedBeforeRetry };
  }

  const codexRecovery = await recoverAfterInitializationTimeout("codex", "retry-recovery-codex");
  const antigravityRecovery = await recoverAfterInitializationTimeout("antigravity", "retry-recovery-antigravity");

  await setProviderControl("codex", { withholdRemaining: 2 });
  const backoffRuntime = createRuntime("always-on", {
    onlyProvider: "codex",
    caseName: "retry-backoff-sequence",
    requestTimeoutMs: 250,
    retryPolicy: retryPolicyOverrides({
      launchLimit: 4,
      initialDelaysMs: [120, 500, 800],
      maxDelayMs: 1_000,
      warningAfterMs: 10_000,
    }),
  });
  await runCauseEffect(backoffRuntime.start());
  await waitForProviderState(backoffRuntime, "codex", "available");
  const backoffEvents = await providerEvents("codex", "retry-backoff-sequence");
  const backoffStarts = backoffEvents.filter((entry) => entry.method === "process-start");
  const firstBackoffGap = (backoffStarts[1]?.at ?? 0) - (backoffStarts[0]?.at ?? 0);
  const secondBackoffGap = (backoffStarts[2]?.at ?? 0) - (backoffStarts[1]?.at ?? 0);
  const increasingBackoffObserved =
    backoffStarts.length === 3 &&
    firstBackoffGap > 0 &&
    secondBackoffGap - firstBackoffGap >= 250 &&
    maximumConcurrentProcesses(backoffEvents) === 1;
  assert.ok(
    increasingBackoffObserved,
    `sequential init failures use increasing delays without overlap (${firstBackoffGap}ms, ${secondBackoffGap}ms)`,
  );
  await stopRuntime(backoffRuntime);

  async function refusedInitializationDoesNotRetry(
    provider: AgentProvider,
    caseName: string,
    behavior: "auth" | "unknown",
  ): Promise<boolean> {
    await setProviderControl(provider, { initializeBehavior: behavior, lastTempDirectory: null });
    const runtime = createRuntime("always-on", {
      onlyProvider: provider,
      caseName,
      requestTimeoutMs: 500,
      retryPolicy: recoveryPolicy,
    });
    await runCauseEffect(runtime.start());
    await new Promise((resume) => setTimeout(resume, 300));
    const count = await providerStartCount(provider, caseName);
    const events = await providerEvents(provider, caseName);
    assert.equal(count, 1, `${behavior} initialization refusal does not enter extended retries`);
    assert.equal(maximumConcurrentProcesses(events), 1);
    await stopRuntime(runtime);
    return count === 1;
  }

  const authRefusalDidNotRetry = await refusedInitializationDoesNotRetry("codex", "retry-auth-refusal", "auth");
  const unknownRefusalDidNotRetry = await refusedInitializationDoesNotRetry(
    "antigravity",
    "retry-unknown-refusal",
    "unknown",
  );

  let diskBytes = 0;
  await setProviderControl("antigravity", {});
  const diskRuntime = createRuntime("always-on", {
    onlyProvider: "antigravity",
    caseName: "retry-disk-space",
    requestTimeoutMs: 500,
    retryPolicy: retryPolicyOverrides({ delayMs: 40, diskSpaceCheckMs: 40 }),
    availableDiskBytes: () => diskBytes,
  });
  await runCauseEffect(diskRuntime.start());
  const diskRefusalDidNotLaunch = (await providerStartCount("antigravity", "retry-disk-space")) === 0;
  assert.ok(diskRefusalDidNotLaunch, "the 1 GiB temp guard refuses before spawning a process");
  diskBytes = 2 * 1024 ** 3;
  await waitForProviderState(diskRuntime, "antigravity", "available");
  await stopRuntime(diskRuntime);

  await setProviderControl("codex", { initializeBehavior: "withhold" });
  const budgetRuntime = createRuntime("always-on", {
    onlyProvider: "codex",
    caseName: "retry-launch-budget",
    requestTimeoutMs: 250,
    retryPolicy: retryPolicyOverrides({ launchLimit: 3, delayMs: 650, warningAfterMs: 450 }),
  });
  await runCauseEffect(budgetRuntime.start());
  const longWarning = await waitFor("the long-running provider warning", async () => {
    const message = providerMessage(budgetRuntime, "codex");
    return message?.includes("24 hours") ? message : null;
  });
  assert.match(longWarning, /still retrying slowly/u);
  await new Promise((resume) => setTimeout(resume, 60));
  assert.equal(await providerStartCount("codex", "retry-launch-budget"), 1);
  await waitFor("the retry episode launch cap", async () => {
    const count = await providerStartCount("codex", "retry-launch-budget");
    return count === 3 && providerMessage(budgetRuntime, "codex")?.includes("stopped trying");
  });
  const budgetStoppedAtLimit = await providerStartCount("codex", "retry-launch-budget");
  assert.equal(budgetStoppedAtLimit, 3, "the interim launch cap counts actual provider processes");
  await new Promise((resume) => setTimeout(resume, 120));
  assert.equal(await providerStartCount("codex", "retry-launch-budget"), 3, "the capped episode stays paused");
  await runCauseEffect(budgetRuntime.refreshProvider("codex"));
  await waitFor(
    "the explicit refresh to start a new episode",
    async () => (await providerStartCount("codex", "retry-launch-budget")) >= 4,
  );
  await waitFor("the reset episode to reach its own launch cap", async () => {
    const count = await providerStartCount("codex", "retry-launch-budget");
    return count === 6 && providerMessage(budgetRuntime, "codex")?.includes("stopped trying");
  });
  const explicitRefreshResetBudget = (await providerStartCount("codex", "retry-launch-budget")) === 6;
  assert.ok(explicitRefreshResetBudget, "an explicit refresh starts a fresh launch budget");
  await stopRuntime(budgetRuntime);

  await setProviderControl("codex", { initializeBehavior: "withhold" });
  const cancelRuntime = createRuntime("always-on", {
    onlyProvider: "codex",
    caseName: "retry-dispose-cancel",
    requestTimeoutMs: 250,
    retryPolicy: retryPolicyOverrides({ delayMs: 900 }),
  });
  await runCauseEffect(cancelRuntime.start());
  await stopRuntime(cancelRuntime);
  await new Promise((resume) => setTimeout(resume, 1_000));
  const disposeCancelledRetry = (await providerStartCount("codex", "retry-dispose-cancel")) === 1;
  assert.ok(disposeCancelledRetry, "dispose invalidates the scheduled episode before another launch");

  report.initializationRetry = {
    codexRecovered: true,
    antigravityRecovered: true,
    increasingBackoffObserved,
    longRunningWarningShown: longWarning.includes("24 hours"),
    authRefusalDidNotRetry,
    unknownRefusalDidNotRetry,
    diskRefusalDidNotLaunch,
    budgetStoppedAtLimit,
    explicitRefreshResetBudget,
    disposeCancelledRetry,
    antigravityTempRemovedBeforeRetry: antigravityRecovery.tempRemovedBeforeRetry,
    maxConcurrentRetryProcesses: Math.max(codexRecovery.maximum, antigravityRecovery.maximum),
  };
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await Promise.allSettled([...runtimes.values()].map(stopRuntime));
  report.providerEvents = [...(await logEntries()), ...(await codexLogEntries())];
  database.close();
  if (priorCodexPath === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = priorCodexPath;
  await mkdir(OUT, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

// Machine-readable: the artifact path is printed for the E2E runner.
process.stdout.write(`${reportPath}\n`);
