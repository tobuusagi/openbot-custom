// Exercises Kimi Connect and code sign-in through ProviderRuntime, with local stand-in CLIs and no
// provider network or OAuth. `node --import tsx scripts/provider-region-signin-e2e.ts` runs the
// process paths and writes .openbot-build/provider-region-signin-e2e/report.json.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";

const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-region-signin-e2e");
const LOG_VARIABLE = "FAKE_KIMI_LOGIN_LOG";
const SCENARIO_VARIABLE = "FAKE_KIMI_SCENARIO";

interface LoginRecord {
  pid: number;
  scenario: string | undefined;
  argv: string[];
  cliNoAutoUpdate: string | null;
  browser: string | null;
  oauthHost: string | null;
  apiBaseUrl: string | null;
}

interface Report {
  passed: boolean;
  validation: {
    platform: NodeJS.Platform;
    hostRuntime: "bun" | "node";
    liveOAuth: "not-tested";
    providerNetwork: "not-used";
  };
  cases: Partial<Record<string, LoginRecord>>;
  codeLoginGlobalDefault?: { kind: string; userCode?: string; verificationUrl?: string };
  error?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-provider-region-signin-e2e-"));
const logPath = join(root, "login.jsonl");
const codeCli = join(root, "kimi-code");
const pythonCli = join(root, "kimi-python");
const environmentBefore = {
  kimiPath: process.env.OPENBOT_KIMI_PATH,
  logPath: process.env[LOG_VARIABLE],
  scenario: process.env[SCENARIO_VARIABLE],
  oauthHost: process.env.KIMI_CODE_OAUTH_HOST,
  apiBaseUrl: process.env.KIMI_CODE_BASE_URL,
  prompt: process.env.FAKE_KIMI_CODE_PROMPT,
};
const report: Report = {
  passed: false,
  validation: {
    platform: process.platform,
    hostRuntime: process.versions.bun ? "bun" : "node",
    liveOAuth: "not-tested",
    providerNetwork: "not-used",
  },
  cases: {},
};

function fakeKimi(version: string, help: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const NL = String.fromCharCode(10);
const args = process.argv.slice(2);
const writeAndExit = (value) => process.stdout.write(value + NL, () => process.exit(0));
if (args[0] === "--version") writeAndExit("kimi, version ${version}");
else if (args[0] === "login" && args[1] === "--help") writeAndExit(${JSON.stringify(help)});
else if (args[0] === "login") {
  const entry = {
    pid: process.pid,
    scenario: process.env.${SCENARIO_VARIABLE},
    argv: args,
    cliNoAutoUpdate: process.env.KIMI_CLI_NO_AUTO_UPDATE ?? null,
    browser: process.env.BROWSER ?? null,
    oauthHost: process.env.KIMI_CODE_OAUTH_HOST ?? null,
    apiBaseUrl: process.env.KIMI_CODE_BASE_URL ?? null,
  };
  fs.appendFileSync(process.env.${LOG_VARIABLE}, JSON.stringify(entry) + NL);
  process.on("SIGTERM", () => process.exit(0));
  if (process.env.FAKE_KIMI_CODE_PROMPT === "1") {
    setImmediate(() => process.stdout.write(["Open: https://example.test/device", "Confirm this code:", "ABC123", ""].join(NL)));
  }
  setInterval(() => {}, 1000);
} else process.exit(2);
`;
}

async function readRecords(): Promise<LoginRecord[]> {
  try {
    return (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line): LoginRecord => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Waits for the real fake-CLI process to record its sign-in command. */
async function waitForScenario(scenario: string): Promise<LoginRecord> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const record = (await readRecords()).find((entry) => entry.scenario === scenario);
    if (record) return record;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the ${scenario} CLI process.`);
    await new Promise((resume) => setTimeout(resume, 10));
  }
}

async function installFake(path: string, version: string, help: string): Promise<void> {
  await writeFile(path, fakeKimi(version, help));
  await chmod(path, 0o755);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const database = new OpenBotDatabase(join(root, "profile"));
const store = new AgentStore(join(root, "profile"), join(root, "home"), database);
const conversation = new ConversationRuntime(
  store,
  () => undefined,
  () => store.list(),
);
const offProviders = BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter((provider) => provider !== "kimi");
const runtime = new ProviderRuntime({
  offProviders,
  conversation,
  hooks: {
    bindClient: () => undefined,
    onProvidersReady: () => Effect.void,
    onProviderLost: () => undefined,
    onClientStopped: () => Effect.void,
    isStopping: () => false,
    isProviderBusy: () => false,
    isAgentBusy: () => false,
    isProviderAssigned: () => false,
    onAgentClientLost: () => Effect.void,
    sharedRoot: () => join(root, "shared"),
    onProviderResumed: () => undefined,
    onProviderActivated: () => Effect.void,
    captureConfigRevision: () => 0,
  },
  emit: () => undefined,
  emitError: () => undefined,
  requestTimeoutMs: 5_000,
  preferredProvider: "kimi",
  clientFactory: null,
  bundledExecutables: {},
  credentials: NO_PROVIDER_CREDENTIALS,
  redactMcp: (text) => text,
});

try {
  assert.notEqual(process.platform, "win32", "This local process E2E uses POSIX executable stand-ins.");
  await mkdir(root, { recursive: true });
  await installFake(codeCli, "2.1.0", "Usage: kimi login --region {global,mainland-cn} device-code");
  await installFake(pythonCli, "1.52.0", "Usage: kimi login --json");
  process.env[LOG_VARIABLE] = logPath;
  delete process.env.KIMI_CODE_OAUTH_HOST;
  delete process.env.KIMI_CODE_BASE_URL;
  delete process.env.FAKE_KIMI_CODE_PROMPT;

  process.env.OPENBOT_KIMI_PATH = codeCli;
  process.env[SCENARIO_VARIABLE] = "kimi-code-mainland-connect";
  await runCauseEffect(runtime.connectProvider("kimi", async () => undefined, "mainland-cn"));
  const kimiCodeMainland = await waitForScenario("kimi-code-mainland-connect");
  assert.deepEqual(kimiCodeMainland.argv, ["login", "--region", "mainland-cn"]);
  report.cases.kimiCodeMainland = kimiCodeMainland;

  process.env.OPENBOT_KIMI_PATH = pythonCli;
  process.env[SCENARIO_VARIABLE] = "kimi-python-global-connect";
  await runCauseEffect(runtime.connectProvider("kimi", async () => undefined));
  const kimiPythonGlobal = await waitForScenario("kimi-python-global-connect");
  assert.deepEqual(kimiPythonGlobal.argv, ["login"]);
  assert.equal(kimiPythonGlobal.oauthHost, "https://auth.kimi.ai");
  assert.equal(kimiPythonGlobal.apiBaseUrl, "https://api.kimi.ai/coding/v1");
  report.cases.kimiPythonGlobal = kimiPythonGlobal;

  process.env[SCENARIO_VARIABLE] = "kimi-python-mainland-connect";
  await runCauseEffect(runtime.connectProvider("kimi", async () => undefined, "mainland-cn"));
  const kimiPythonMainland = await waitForScenario("kimi-python-mainland-connect");
  assert.deepEqual(kimiPythonMainland.argv, ["login"]);
  assert.equal(kimiPythonMainland.oauthHost, null);
  assert.equal(kimiPythonMainland.apiBaseUrl, null);
  report.cases.kimiPythonMainland = kimiPythonMainland;

  process.env.OPENBOT_KIMI_PATH = codeCli;
  process.env[SCENARIO_VARIABLE] = "kimi-code-global-code-login";
  process.env.FAKE_KIMI_CODE_PROMPT = "1";
  const codeLogin = await runCauseEffect(runtime.startProviderCodeLogin("kimi"));
  const kimiCodeGlobal = await waitForScenario("kimi-code-global-code-login");
  assert.deepEqual(kimiCodeGlobal.argv, ["login", "--region", "global"]);
  assert.equal(codeLogin.kind, "code");
  report.cases.kimiCodeGlobalCodeLogin = kimiCodeGlobal;
  report.codeLoginGlobalDefault = {
    kind: codeLogin.kind,
    ...(codeLogin.kind === "code" ? { userCode: codeLogin.userCode, verificationUrl: codeLogin.verificationUrl } : {}),
  };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await runCauseEffect(runtime.dispose()).catch(() => []);
  restoreEnvironment("OPENBOT_KIMI_PATH", environmentBefore.kimiPath);
  restoreEnvironment(LOG_VARIABLE, environmentBefore.logPath);
  restoreEnvironment(SCENARIO_VARIABLE, environmentBefore.scenario);
  restoreEnvironment("KIMI_CODE_OAUTH_HOST", environmentBefore.oauthHost);
  restoreEnvironment("KIMI_CODE_BASE_URL", environmentBefore.apiBaseUrl);
  restoreEnvironment("FAKE_KIMI_CODE_PROMPT", environmentBefore.prompt);
  await rm(root, { recursive: true, force: true });
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
