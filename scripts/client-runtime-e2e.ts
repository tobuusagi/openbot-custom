import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { build as electronViteBuild } from "electron-vite";
import { z } from "zod";

const reportPath = resolve(".openbot-build/client-runtime-e2e/report.json");
const e2eOutput = resolve("out-client-e2e");
const e2eMain = join(e2eOutput, "main", "e2e-index.js");
const expectedEmail = "client-runtime@example.test";
const expectedCode = "ABCD2345";
const expectedFormattedCode = "ABCD-2345";
const expectedToken = "local-client-runtime-e2e-session";
const expectedUser = {
  id: "client-runtime-e2e-user",
  email: expectedEmail,
  name: "E2E Account",
  avatarUrl: null,
  analyticsEnabled: null,
};
const expectedRendererImages = new Set([
  "assets/ball-pink.webp",
  "assets/ball-lilac.webp",
  "assets/ball-mint.webp",
  "assets/eye-right.webp",
  "assets/eye-left.webp",
  "assets/body-lilac.webp",
]);

interface ApiRequestRecord {
  method: string;
  path: string;
  status: number;
}

interface RendererAssetRecord {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  firstBytesHex: string;
  textPrefix: string | null;
  references: string[];
  referencedBy: string[];
}

interface ClientRuntimeReport {
  completed: boolean;
  runtimeBundleBuilt: boolean;
  childStarted: boolean;
  childClosed: boolean;
  childExitCode: number | null;
  headless: boolean;
  rendererLoaded: boolean;
  rendererUrl: string | null;
  rendererRequests: string[];
  rendererRequestsStayedLocal: boolean;
  rendererHtmlStylesheets: string[];
  rendererAssets: RendererAssetRecord[];
  startupDiagnostics: ClientRuntimeDiagnostic[];
  startupFailure: Extract<ClientRuntimeDiagnostic, { type: "startup-error" }> | null;
  debuggerFailure: string | null;
  healthChecked: boolean;
  emailCodeRequested: boolean;
  emailCodeVerified: boolean;
  authenticatedProfileRead: boolean;
  logoutRequested: boolean;
  verificationPayloadValid: boolean | null;
  verificationChallengeMatched: boolean | null;
  verificationCodeMatched: boolean | null;
  apiRequests: ApiRequestRecord[];
  temporaryProfileRemoved: boolean;
  testBundleRemoved: boolean;
  failure?: string;
}

const CLIENT_DEBUGGING_TARGETS = z.array(
  z
    .object({
      type: z.string(),
      url: z.string(),
      webSocketDebuggerUrl: z.string(),
    })
    .passthrough(),
);
const CLIENT_EMAIL_START_REQUEST = z.strictObject({ email: z.string() });
const CLIENT_EMAIL_VERIFY_REQUEST = z.strictObject({ challengeId: z.string(), code: z.string() });
const CLIENT_EMAIL_NAME = z.string().nullable();
const CLIENT_RENDERER_BOOLEAN = z.boolean();
const CLIENT_RENDERER_SIGNED_OUT = z.literal("signed_out");
const CLIENT_RENDERER_PROFILE = z.strictObject({ status: z.string(), email: z.string().nullable() });
const CDP_COMMAND_RESULT = z
  .object({
    result: z.object({ value: z.unknown().optional() }).passthrough().optional(),
    exceptionDetails: z.object({ text: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const CDP_RESPONSE = z
  .object({
    id: z.number().int(),
    result: CDP_COMMAND_RESULT.optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const CDP_NETWORK_REQUEST = z
  .object({
    method: z.literal("Network.requestWillBeSent"),
    params: z
      .object({
        request: z.object({ url: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
const CLIENT_RUNTIME_DIAGNOSTIC = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stage"), stage: z.string() }),
  z.strictObject({
    type: z.literal("startup-error"),
    stage: z.string(),
    errorName: z.string(),
    errorCode: z.union([z.number(), z.string()]).nullable(),
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal("did-fail-load"),
    stage: z.string(),
    errorCode: z.number(),
    errorDescription: z.string(),
    validatedUrl: z.string(),
    isMainFrame: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("render-process-gone"),
    stage: z.string(),
    reason: z.string(),
    exitCode: z.number(),
  }),
  z.strictObject({
    type: z.literal("preload-error"),
    stage: z.string(),
    preloadPath: z.string(),
    errorName: z.string(),
    message: z.string(),
  }),
]);
type CdpTarget = z.output<typeof CLIENT_DEBUGGING_TARGETS>[number];
type CdpCommandResult = z.output<typeof CDP_COMMAND_RESULT>;
type ClientRuntimeDiagnostic = z.output<typeof CLIENT_RUNTIME_DIAGNOSTIC>;
type CdpCommand =
  | { method: "Network.enable" | "Page.enable" | "Browser.close" }
  | { method: "Page.reload"; params: { ignoreCache: boolean } }
  | {
      method: "Runtime.evaluate";
      params: {
        expression: string;
        awaitPromise: true;
        returnByValue: true;
        userGesture: true;
      };
    };

const report: ClientRuntimeReport = {
  completed: false,
  runtimeBundleBuilt: false,
  childStarted: false,
  childClosed: false,
  childExitCode: null,
  headless: false,
  rendererLoaded: false,
  rendererUrl: null,
  rendererRequests: [],
  rendererRequestsStayedLocal: false,
  rendererHtmlStylesheets: [],
  rendererAssets: [],
  startupDiagnostics: [],
  startupFailure: null,
  debuggerFailure: null,
  healthChecked: false,
  emailCodeRequested: false,
  emailCodeVerified: false,
  authenticatedProfileRead: false,
  logoutRequested: false,
  verificationPayloadValid: null,
  verificationChallengeMatched: null,
  verificationCodeMatched: null,
  apiRequests: [],
  temporaryProfileRemoved: false,
  testBundleRemoved: false,
};

let temporaryRoot: string | null = null;
let apiServer: Server | null = null;
let child: ChildProcess | null = null;
let childExit: Promise<void> | null = null;
let cdp: CdpClient | null = null;
let apiPort: number | null = null;
let debuggingPort: number | null = null;
let childOutput = "";

async function main(): Promise<void> {
  try {
    await electronViteBuild({ configFile: resolve("electron.client.e2e.vite.config.ts") });
    report.runtimeBundleBuilt = true;
    await access(e2eMain);
    await captureRendererAssets();

    temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-client-runtime-e2e-"));
    const profilePath = join(temporaryRoot, "profile");
    await mkdir(profilePath, { recursive: true });
    debuggingPort = await findFreeTcpPort();
    apiPort = await startFakeAccountApi();
    await launchClient(profilePath);

    const target = await waitForRendererTarget(debuggingPort, 20_000);
    if (target.url !== "openbot-app://app/client.html") {
      throw new Error(`The client window loaded an unexpected page: ${target.url}`);
    }
    report.rendererUrl = target.url;
    report.rendererLoaded = true;
    await waitForStartupStage("after-load-url", 20_000);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    cdp.onNetworkRequest((url) => {
      if (!report.rendererRequests.includes(url)) report.rendererRequests.push(url);
    });
    await cdp.send({ method: "Network.enable" });
    await cdp.send({ method: "Page.enable" });
    await cdp.send({ method: "Page.reload", params: { ignoreCache: true } });
    await waitForRendererState(cdp, "document.querySelector('#account-email') !== null", 15_000);

    await cdp.evaluate(
      `(() => {
        const input = document.querySelector('#account-email');
        if (!(input instanceof HTMLInputElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(expectedEmail)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.form?.requestSubmit();
        return true;
      })()`,
      CLIENT_RENDERER_BOOLEAN,
    );
    await waitForRendererState(cdp, `document.querySelector('[data-auth-panel="code"]') !== null`, 15_000);
    report.emailCodeRequested = true;

    await cdp.evaluate(
      `(() => {
        const input = document.querySelector('input[autocomplete="one-time-code"]');
        if (!(input instanceof HTMLInputElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(expectedCode)});
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertReplacementText',
          data: ${JSON.stringify(expectedCode)},
        }));
        return true;
      })()`,
      CLIENT_RENDERER_BOOLEAN,
    );
    await waitForRendererState(cdp, `document.querySelector('#client-account-title') !== null`, 15_000);
    const displayedName = await cdp.evaluate(
      "document.querySelector('.client-account-name')?.textContent?.trim() ?? null",
      CLIENT_EMAIL_NAME,
    );
    if (displayedName !== expectedUser.name) throw new Error("The signed-in account screen showed the wrong user.");
    report.emailCodeVerified = true;

    const profile = await cdp.evaluate(
      "window.clientAccount.retry().then((state) => ({ status: state.status, email: state.status === 'signed_in' ? state.user.email : null }))",
      CLIENT_RENDERER_PROFILE,
    );
    if (profile.status !== "signed_in" || profile.email !== expectedEmail) {
      throw new Error("The client did not restore the signed-in profile through /v1/me.");
    }
    report.authenticatedProfileRead = true;

    await cdp.evaluate("document.querySelector('.client-account-sign-out')?.click() ?? false", CLIENT_RENDERER_BOOLEAN);
    await waitForRendererState(cdp, "document.querySelector('#account-email') !== null", 15_000);
    const signedOut = await cdp.evaluate(
      "window.clientAccount.getState().then((state) => state.status)",
      CLIENT_RENDERER_SIGNED_OUT,
    );
    if (signedOut !== "signed_out") throw new Error("The client did not return to the signed-out screen.");

    const rendererRequestsStayedLocal = report.rendererRequests.every(
      (url) => url.startsWith("openbot-app://app/") || url.startsWith("data:"),
    );
    report.rendererRequestsStayedLocal = rendererRequestsStayedLocal;
    if (!rendererRequestsStayedLocal) throw new Error("The renderer attempted a request outside its bundled origin.");
    const rendererUrl = report.rendererUrl;
    if (!rendererUrl) throw new Error("The client renderer URL was not recorded.");
    const requiredRendererFiles = [
      "openbot-app://app/client.html",
      "openbot-app://app/client-entry.js",
      ...report.rendererHtmlStylesheets.map((href) => new URL(href, rendererUrl).toString()),
    ];
    const missingRendererFiles = requiredRendererFiles.filter((url) => !report.rendererRequests.includes(url));
    if (missingRendererFiles.length > 0) {
      throw new Error(`The renderer did not load bundled files: ${missingRendererFiles.join(", ")}.`);
    }
    assertApiFlows(report.apiRequests);

    await closeExactChild();
    if (report.childExitCode !== 0) throw new Error(`The Electron child exited with status ${report.childExitCode}.`);
    report.completed = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.failure = childOutput ? `${message} (${childOutput.slice(-1_500).trim()})` : message;
  } finally {
    await closeExactChild();
    report.startupDiagnostics = parseClientRuntimeDiagnostics(childOutput);
    for (const diagnostic of report.startupDiagnostics) {
      if (diagnostic.type === "startup-error") report.startupFailure = diagnostic;
    }
    if (report.startupFailure) {
      report.debuggerFailure = report.failure ?? null;
      report.failure = formatStartupFailure(report.startupFailure);
    }
    cdp?.close();
    await stopFakeApi();
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
      report.temporaryProfileRemoved = true;
    }
    await rm(e2eOutput, { recursive: true, force: true });
    report.testBundleRemoved = true;
    await writeFileReport();
  }

  if (!report.completed) throw new Error(report.failure ?? "The client runtime E2E did not complete.");
}

async function launchClient(profilePath: string): Promise<void> {
  if (apiPort === null || debuggingPort === null) throw new Error("The client E2E ports were not initialized.");
  const electronExecutable = resolve(
    process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/electron/dist/electron",
  );
  await access(electronExecutable);
  report.headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const args = [...(report.headless ? ["--headless"] : []), e2eMain];
  child = spawn(electronExecutable, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLIENT_E2E_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      CLIENT_E2E_USER_DATA: profilePath,
      CLIENT_E2E_STORAGE_KEY: randomBytes(32).toString("hex"),
      CLIENT_E2E_DEBUGGING_PORT: String(debuggingPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  report.childStarted = true;
  childExit = new Promise<void>((resolveExit) => {
    child?.once("exit", (code) => {
      report.childExitCode = code;
      report.childClosed = true;
      resolveExit();
    });
  });
  const appendOutput = (chunk: Buffer | string) => {
    childOutput = `${childOutput}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
}

async function captureRendererAssets(): Promise<void> {
  const rendererDirectory = join(e2eOutput, "renderer");
  const html = await readFile(join(rendererDirectory, "client.html"), "utf8");
  const rendererEntry = await readFile(join(rendererDirectory, "client-entry.js"), "utf8");
  report.rendererHtmlStylesheets = [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    return rel?.split(/\s+/).includes("stylesheet") && href ? [href] : [];
  });

  const files = await listRendererFiles(rendererDirectory);
  report.rendererAssets = await Promise.all(
    files.map(async (fileName) => {
      const content = await readFile(join(rendererDirectory, ...fileName.split("/")));
      const mediaType = rendererAssetMediaType(fileName, content);
      const text = content.toString("utf8");
      const references =
        mediaType === "text/css"
          ? [...text.matchAll(/(?:url\(\s*|@import\s+)["']?([^"')\s;]+)["']?\s*\)?/gi)].flatMap(([, reference]) =>
              reference && !reference.startsWith("data:") && !reference.startsWith("#") ? [reference] : [],
            )
          : [];
      const baseName = fileName.slice(fileName.lastIndexOf("/") + 1);
      const referencedBy = [
        ...(html.includes(fileName) || html.includes(baseName) ? ["client.html"] : []),
        ...(rendererEntry.includes(fileName) || rendererEntry.includes(baseName) ? ["client-entry.js"] : []),
      ];
      const textPrefix =
        mediaType.startsWith("text/") || mediaType === "image/svg+xml"
          ? content.subarray(0, 160).toString("utf8").replace(/\s+/g, " ").trim()
          : null;
      return {
        fileName,
        mediaType,
        sizeBytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        firstBytesHex: content.subarray(0, 16).toString("hex"),
        textPrefix,
        references,
        referencedBy,
      };
    }),
  );
  const images = report.rendererAssets.filter(({ mediaType }) => mediaType.startsWith("image/"));
  const imageNames = new Set(images.map(({ fileName }) => fileName));
  if (
    images.length !== expectedRendererImages.size ||
    [...expectedRendererImages].some((name) => !imageNames.has(name)) ||
    images.some(
      ({ mediaType, firstBytesHex }) =>
        mediaType !== "image/webp" ||
        firstBytesHex.slice(0, 8) !== "52494646" ||
        firstBytesHex.slice(16, 24) !== "57454250",
    )
  ) {
    throw new Error("The client renderer image assets do not match the declared WebP package allowlist.");
  }
  const unexpectedFiles = report.rendererAssets
    .filter(
      ({ fileName }) =>
        !["client.html", "client-entry.js", "client-entry.css", ...expectedRendererImages].includes(fileName),
    )
    .map(({ fileName }) => fileName);
  if (unexpectedFiles.length > 0) {
    throw new Error(`The client renderer emitted unapproved files: ${unexpectedFiles.join(", ")}.`);
  }
}

async function listRendererFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listRendererFiles(root, entryPath)));
    else if (entry.isFile()) result.push(relative(root, entryPath).split(sep).join("/"));
  }
  return result.sort();
}

function rendererAssetMediaType(
  fileName: string,
  content: Buffer,
):
  | "image/svg+xml"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "text/css"
  | "text/html"
  | "text/javascript"
  | "font/woff"
  | "font/woff2"
  | "application/octet-stream" {
  const prefix = content.subarray(0, 512).toString("utf8").trimStart();
  if (prefix.includes("<svg")) return "image/svg+xml";
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  const extension = extname(fileName).toLowerCase();
  if (extension === ".css") return "text/css";
  if (extension === ".html") return "text/html";
  if (extension === ".js") return "text/javascript";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function parseClientRuntimeDiagnostics(output: string): ClientRuntimeDiagnostic[] {
  const prefix = "[client-runtime-e2e-diagnostic] ";
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(prefix)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(prefix.length));
    } catch {
      return [];
    }
    const diagnostic = CLIENT_RUNTIME_DIAGNOSTIC.safeParse(parsed);
    return diagnostic.success ? [diagnostic.data] : [];
  });
}

function formatStartupFailure(failure: Extract<ClientRuntimeDiagnostic, { type: "startup-error" }>): string {
  const errorCode = failure.errorCode === null ? "" : ` (${failure.errorCode})`;
  return `Client runtime startup failed at ${failure.stage}: ${failure.errorName}${errorCode}: ${failure.message}`;
}

async function startFakeAccountApi(): Promise<number> {
  const server = createServer((request, response) => {
    void handleFakeApiRequest(request, response).catch(() => sendJson(response, 500, { error: "test server error" }));
  });
  apiServer = server;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake account API has no TCP address.");
  return address.port;
}

async function handleFakeApiRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  let status = 404;
  if (path === "/health/live" && method === "GET") {
    status = 200;
    sendJson(response, status, { status: "ok" });
  } else if (path === "/v1/auth/email/start" && method === "POST") {
    const body = await readJsonBody(request, CLIENT_EMAIL_START_REQUEST);
    if (body.email !== expectedEmail) {
      status = 400;
      sendJson(response, status, { error: { code: "invalid_email", message: "Invalid test address." } });
    } else {
      status = 200;
      sendJson(response, status, {
        challengeId: "client-runtime-e2e-challenge",
        expiresAt: Date.now() + 300_000,
        resendAt: Date.now() + 60_000,
      });
    }
  } else if (path === "/v1/auth/email/verify" && method === "POST") {
    const body = await readJsonBody(request, CLIENT_EMAIL_VERIFY_REQUEST);
    report.verificationChallengeMatched = body.challengeId === "client-runtime-e2e-challenge";
    report.verificationCodeMatched = body.code === expectedFormattedCode;
    report.verificationPayloadValid =
      body.challengeId === "client-runtime-e2e-challenge" && body.code === expectedFormattedCode;
    if (body.challengeId !== "client-runtime-e2e-challenge" || body.code !== expectedFormattedCode) {
      status = 400;
      sendJson(response, status, { error: { code: "invalid_sign_in_code", message: "Invalid test code." } });
    } else {
      status = 200;
      sendJson(response, status, { sessionToken: expectedToken, user: expectedUser });
    }
  } else if (path === "/v1/me" && method === "GET") {
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      status = 401;
      sendJson(response, status, { error: { code: "unauthorized", message: "Missing test session." } });
    } else {
      status = 200;
      sendJson(response, status, expectedUser);
    }
  } else if (path === "/v1/auth/logout" && method === "POST") {
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      status = 401;
      sendJson(response, status, { error: { code: "unauthorized", message: "Missing test session." } });
    } else {
      status = 204;
      response.writeHead(status, { "Cache-Control": "no-store" });
      response.end();
    }
  } else {
    sendJson(response, status, { error: { code: "not_found", message: "No E2E route." } });
  }
  report.apiRequests.push({ method, path, status });
}

async function readJsonBody<Schema extends z.ZodType>(
  request: IncomingMessage,
  schema: Schema,
): Promise<z.output<Schema>> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += data.byteLength;
    if (byteCount > 16_384) throw new Error("The E2E request body exceeded its bound.");
    chunks.push(data);
  }
  return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function waitForRendererTarget(port: number, timeoutMs: number): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "The Electron renderer did not open its debugging endpoint.";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`The Electron child exited before opening the client window (${child.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = CLIENT_DEBUGGING_TARGETS.safeParse(await response.json());
        if (!targets.success) throw new Error("The Electron debugging endpoint returned invalid targets.");
        const target = targets.data.find(({ type }) => type === "page");
        if (target) return target;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(75);
  }
  throw new Error(`${lastError} Timed out waiting for the client renderer.`);
}

async function waitForStartupStage(stage: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = parseClientRuntimeDiagnostics(childOutput);
    if (diagnostics.some((item) => item.type === "stage" && item.stage === stage)) return;
    const failure = diagnostics.find((item) => item.type === "startup-error");
    if (failure?.type === "startup-error") throw new Error(formatStartupFailure(failure));
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`The Electron child exited before startup stage ${stage} (${child.exitCode}).`);
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for client startup stage ${stage}.`);
}

async function waitForRendererState(cdpSession: CdpClient, expression: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`The Electron child exited while the renderer was updating (${child.exitCode}).`);
    }
    if (await cdpSession.evaluate(expression, CLIENT_RENDERER_BOOLEAN)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for renderer state: ${expression}`);
}

async function findFreeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The CDP port probe has no TCP address.");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return port;
}

async function closeExactChild(): Promise<void> {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null && cdp) {
    await cdp.send({ method: "Browser.close" }).catch(() => undefined);
    if (await waitForExit(3_000)) {
      report.childExitCode = child.exitCode;
      report.childClosed = child.exitCode !== null || child.signalCode !== null;
      return;
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (!(await waitForExit(3_000))) child.kill("SIGKILL");
    await waitForExit(2_000);
  }
  report.childExitCode = child.exitCode;
  report.childClosed = child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(timeoutMs: number): Promise<boolean> {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (!childExit) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    childExit.then(() => true),
    new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function stopFakeApi(): Promise<void> {
  if (!apiServer?.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    apiServer?.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function assertApiFlows(requests: readonly ApiRequestRecord[]): void {
  const names = new Set(requests.map(({ method, path }) => `${method} ${path}`));
  const required = [
    "GET /health/live",
    "POST /v1/auth/email/start",
    "POST /v1/auth/email/verify",
    "GET /v1/me",
    "POST /v1/auth/logout",
  ];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`The fake account API did not receive: ${missing.join(", ")}.`);
  const unexpected = requests.filter(({ method, path }) => !required.includes(`${method} ${path}`));
  if (unexpected.length > 0) {
    throw new Error(
      `The client called an unexpected fake API route: ${unexpected.map(({ method, path }) => `${method} ${path}`).join(", ")}.`,
    );
  }
  report.healthChecked = requests.some(
    ({ method, path, status }) => method === "GET" && path === "/health/live" && status === 200,
  );
  report.emailCodeRequested = requests.some(
    ({ method, path, status }) => method === "POST" && path === "/v1/auth/email/start" && status === 200,
  );
  report.emailCodeVerified = requests.some(
    ({ method, path, status }) => method === "POST" && path === "/v1/auth/email/verify" && status === 200,
  );
  report.authenticatedProfileRead = requests.some(
    ({ method, path, status }) => method === "GET" && path === "/v1/me" && status === 200,
  );
  report.logoutRequested = requests.some(
    ({ method, path, status }) => method === "POST" && path === "/v1/auth/logout" && status === 204,
  );
  if (
    !report.healthChecked ||
    !report.emailCodeRequested ||
    !report.emailCodeVerified ||
    !report.authenticatedProfileRead ||
    !report.logoutRequested
  ) {
    throw new Error("At least one account API flow did not succeed.");
  }
}

async function writeFileReport(): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve: (value: CdpCommandResult) => void; reject: (error: Error) => void }>();
  readonly #requestListeners = new Set<(url: string) => void>();
  #nextId = 0;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event) => {
      void this.#onMessage(event.data);
    });
    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("The Electron debugging session closed."));
      this.#pending.clear();
    });
  }

  async connect(): Promise<void> {
    await withTimeout(
      new Promise<void>((resolveOpen, rejectOpen) => {
        this.#socket.addEventListener("open", () => resolveOpen(), { once: true });
        this.#socket.addEventListener(
          "error",
          () => rejectOpen(new Error("Could not connect to Electron debugging.")),
          {
            once: true,
          },
        );
      }),
      5_000,
      "Timed out connecting to Electron debugging.",
    );
  }

  onNetworkRequest(listener: (url: string) => void): void {
    this.#requestListeners.add(listener);
  }

  async send(command: CdpCommand): Promise<CdpCommandResult> {
    const id = ++this.#nextId;
    return withTimeout(
      new Promise<CdpCommandResult>((resolveResponse, rejectResponse) => {
        this.#pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
        this.#socket.send(JSON.stringify({ id, ...command }));
      }),
      8_000,
      `Timed out waiting for Electron debugging method ${command.method}.`,
    ).finally(() => this.#pending.delete(id));
  }

  async evaluate<Value>(expression: string, schema: z.ZodType<Value>): Promise<Value> {
    const response = await this.send({
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    });
    if (response.exceptionDetails) throw new Error("The client renderer evaluation failed.");
    if (!response.result) throw new Error("The client renderer returned no evaluation result.");
    return schema.parse(response.result.value);
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close();
    }
  }

  async #onMessage(value: unknown): Promise<void> {
    const text = typeof value === "string" ? value : value instanceof Blob ? await value.text() : "";
    if (!text) return;
    try {
      const value = JSON.parse(text);
      const response = CDP_RESPONSE.safeParse(value);
      if (response.success) {
        const pending = this.#pending.get(response.data.id);
        if (!pending) return;
        if (response.data.error) {
          pending.reject(new Error(response.data.error.message ?? "Electron debugging returned an error."));
        } else {
          pending.resolve(CDP_COMMAND_RESULT.parse(response.data.result ?? {}));
        }
        return;
      }
      const request = CDP_NETWORK_REQUEST.safeParse(value);
      if (!request.success) return;
      for (const listener of this.#requestListeners) listener(request.data.params.request.url);
    } catch {
      return;
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolveTimeout, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Client runtime E2E failed: ${message}\n`);
  process.exitCode = 1;
});
