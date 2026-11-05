import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import { Effect } from "effect";
import { type AuthHttpHandlers, apiError, handleAuthHttpRequest, methodNotAllowedResponse } from "../server/auth-http";
import { JSON_BODY_LIMIT } from "../server/json-body";
import { createSelfHostedAuthServices, SelfHostedAuthConfigurationError } from "./auth-services";
import {
  readSelfHostedConfig,
  readSelfHostedSmtpConfiguration,
  type SelfHostedConfig,
  SelfHostedConfigError,
} from "./config";
import { createSelfHostedEmailCodeDelivery } from "./email-delivery";
import { openSqliteD1Database, type SqliteD1Database } from "./sqlite-d1";
import { readSelfHostedSystemdCredentials, SelfHostedSystemdCredentialsError } from "./systemd-credentials";

const COMPONENT = "self-hosted-account-runtime";
const AUTH_PATHS = new Set([
  "/v1/auth/email/start",
  "/v1/auth/email/verify",
  "/v1/me",
  "/v1/auth/logout",
  "/.well-known/jwks.json",
]);

type Readiness = {
  sqlite: "available" | "unavailable";
  schema: "available" | "unavailable";
  ticketSigning: "available" | "not_configured" | "invalid";
  emailDelivery: "configured" | "development_code" | "not_configured" | "invalid";
  companySignIn: "not_configured" | "enabled_unsupported";
  authApi: "available" | "unavailable";
};

async function startSelfHostedRuntime(): Promise<void> {
  let config: SelfHostedConfig;
  let runtimeEnvironment: NodeJS.ProcessEnv = process.env;
  try {
    const credentialOptIn = process.env.OPENBOT_SELF_HOSTED_SYSTEMD_CREDENTIALS;
    if (credentialOptIn !== undefined && credentialOptIn !== "true") {
      throw new SelfHostedConfigError(["OPENBOT_SELF_HOSTED_SYSTEMD_CREDENTIALS"]);
    }
    if (credentialOptIn === "true") {
      const directory = process.env.CREDENTIALS_DIRECTORY;
      if (!directory) throw new SelfHostedSystemdCredentialsError("credentials_directory_missing");
      const credentials = await Effect.runPromise(readSelfHostedSystemdCredentials(directory));
      runtimeEnvironment = { ...process.env, ...credentials };
    }
    config = readSelfHostedConfig(runtimeEnvironment);
  } catch (cause) {
    if (cause instanceof SelfHostedConfigError) {
      writeError("configuration_invalid", { variables: cause.variables });
      process.exitCode = 1;
      return;
    }
    if (cause instanceof SelfHostedSystemdCredentialsError) {
      writeError("systemd_credentials_invalid", {
        code: cause.code,
        ...(cause.credential ? { credential: cause.credential } : {}),
      });
      process.exitCode = 1;
      return;
    }
    writeError("configuration_failed");
    process.exitCode = 1;
    return;
  }

  let database: SqliteD1Database | null = null;
  let authHandlers: AuthHttpHandlers | null = null;
  const smtp = readSelfHostedSmtpConfiguration(runtimeEnvironment);
  const readiness: Readiness = {
    sqlite: "unavailable",
    schema: "unavailable",
    ticketSigning: "not_configured",
    emailDelivery: config.exposeDevelopmentCode ? "development_code" : smtp.status,
    companySignIn: "not_configured",
    authApi: "unavailable",
  };
  try {
    database = openSqliteD1Database(config.databasePath);
    readiness.sqlite = "available";
    const delivery =
      !config.exposeDevelopmentCode && smtp.status === "configured"
        ? createSelfHostedEmailCodeDelivery(smtp.config)
        : null;
    const services = await createSelfHostedAuthServices(database, config, delivery);
    readiness.schema = "available";
    readiness.ticketSigning = "available";
    readiness.emailDelivery = config.exposeDevelopmentCode ? "development_code" : smtp.status;
    if (services.authService.configured) {
      authHandlers = services.handlers;
      readiness.authApi = "available";
    }
  } catch (cause) {
    if (cause instanceof SelfHostedAuthConfigurationError) {
      if (cause.code !== "schema_not_ready") readiness.schema = "available";
      if (cause.code === "ticket_signing_invalid") readiness.ticketSigning = "invalid";
      if (cause.code === "company_sign_in_not_supported") readiness.companySignIn = "enabled_unsupported";
      writeInfo("account_api_unavailable", { code: cause.code });
    } else {
      writeInfo("account_api_unavailable", { code: "schema_not_ready" });
    }
    if (!database) writeInfo("sqlite_unavailable");
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, readiness, authHandlers);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;

  let stopping = false;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    writeInfo("shutdown_started", { signal });
    server.close((cause) => {
      database?.close();
      if (cause) {
        writeError("shutdown_failed", { code: safeErrorCode(cause) });
        process.exitCode = 1;
        return;
      }
      writeInfo("shutdown_complete", { signal });
    });
    server.closeIdleConnections();
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  server.once("error", (cause) => {
    database?.close();
    writeError("listener_failed", { code: safeErrorCode(cause) });
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      writeError("listener_address_unavailable");
      process.exitCode = 1;
      server.close(() => database?.close());
      return;
    }
    // Machine-readable: the local E2E process waits for this event to learn the ephemeral port.
    writeInfo("listening", { host: config.host, port: address.port, sqlite: readiness.sqlite });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  readiness: Readiness,
  authHandlers: AuthHttpHandlers | null,
): Promise<void> {
  const path = requestPath(request);
  if (!path) {
    request.resume();
    sendJson(request, response, 400, { error: { code: "invalid_request" } });
    return;
  }
  if (path === "/health/live" || path === "/health/ready") {
    handleHealthRequest(request, response, path, readiness);
    return;
  }

  const authPath = AUTH_PATHS.has(path);
  const method = request.method ?? "";
  let authRequestBody: Buffer | null = null;
  if (authPath) {
    if (declaredBodyExceedsLimit(request)) {
      rejectOversizedAuthRequest(request, response);
      return;
    }
    const body = await readBoundedAuthRequestBody(request);
    if (body === "too_large") {
      rejectOversizedAuthRequest(request, response);
      return;
    }
    if (body === "aborted") return;
    authRequestBody = body;
  }
  if (authPath && method !== allowedMethod(path)) {
    await sendResponse(request, response, methodNotAllowedResponse(allowedMethod(path)));
    return;
  }
  if (!authPath && method !== "GET" && method !== "HEAD") {
    request.resume();
    sendJson(request, response, 405, { error: { code: "method_not_allowed" } }, { Allow: "GET, HEAD" });
    return;
  }
  if ((authPath && method === "GET") || !authPath) {
    if (hasRequestBody(request)) {
      request.resume();
      sendJson(request, response, 400, { error: { code: "request_body_not_supported" } });
      return;
    }
  }
  if (authPath && !authHandlers) {
    await sendResponse(request, response, apiError(503, "account_api_not_ready", "The account service is not ready."));
    return;
  }
  if (authPath && authHandlers) {
    const webRequest = toWebRequest(request, authRequestBody);
    const handled = handleAuthHttpRequest(webRequest, request.socket.remoteAddress ?? "", authHandlers);
    if (handled) {
      try {
        await sendResponse(request, response, await handled);
      } catch {
        writeInfo("request_failed", { path: authPath ? path : "unsupported" });
        await sendResponse(
          request,
          response,
          apiError(500, "internal_error", "The account service could not complete the request."),
        );
      }
      return;
    }
  }

  request.resume();
  sendJson(request, response, 501, { error: { code: "account_api_not_implemented" } }, { Connection: "close" });
}

function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: "/health/live" | "/health/ready",
  readiness: Readiness,
): void {
  const method = request.method ?? "";
  if (method !== "GET" && method !== "HEAD") {
    request.resume();
    sendJson(request, response, 405, { error: { code: "method_not_allowed" } }, { Allow: "GET, HEAD" });
    return;
  }
  if (hasRequestBody(request)) {
    request.resume();
    sendJson(request, response, 400, { error: { code: "request_body_not_supported" } });
    return;
  }
  if (path === "/health/live") {
    sendJson(request, response, 200, { service: "openbot-account-gateway", status: "live" });
    return;
  }
  const ready =
    readiness.sqlite === "available" &&
    readiness.schema === "available" &&
    readiness.ticketSigning === "available" &&
    (readiness.emailDelivery === "configured" || readiness.emailDelivery === "development_code") &&
    readiness.authApi === "available";
  sendJson(request, response, ready ? 200 : 503, {
    service: "openbot-account-gateway",
    status: ready ? "ready" : "not_ready",
    ready,
    checks: readiness,
  });
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function hasRequestBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const rawLength = request.headers["content-length"];
  return rawLength !== undefined && rawLength !== "0";
}

function declaredBodyExceedsLimit(request: IncomingMessage): boolean {
  const rawLength = request.headers["content-length"];
  if (typeof rawLength !== "string") return false;
  if (!/^\d+$/u.test(rawLength)) return true;
  const length = Number(rawLength);
  return !Number.isSafeInteger(length) || length > JSON_BODY_LIMIT;
}

function readBoundedAuthRequestBody(request: IncomingMessage): Promise<Buffer | null | "too_large" | "aborted"> {
  if (!hasRequestBody(request)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > JSON_BODY_LIMIT) {
        request.pause();
        cleanup();
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, byteLength));
    };
    const onAborted = () => {
      cleanup();
      resolve("aborted");
    };
    const onError = () => {
      cleanup();
      resolve("aborted");
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    request.resume();
  });
}

function rejectOversizedAuthRequest(request: IncomingMessage, response: ServerResponse): void {
  const ignoreRequestError = () => {};
  const closeRequest = () => {
    request.off("error", ignoreRequestError);
    if (!request.socket.destroyed) request.socket.destroy();
  };
  request.once("error", ignoreRequestError);
  response.once("finish", closeRequest);
  response.once("close", closeRequest);
  sendJson(
    request,
    response,
    413,
    { error: { code: "request_too_large", message: "The request body is too large." } },
    { Connection: "close" },
  );
}

function allowedMethod(path: string): "GET" | "POST" {
  return path === "/v1/me" || path === "/.well-known/jwks.json" ? "GET" : "POST";
}

function toWebRequest(request: IncomingMessage, body: Buffer | null): Request {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || isHopByHopHeader(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    Object.assign(init, { body: body ?? undefined, duplex: "half" });
  }
  return new Request(new URL(request.url ?? "/", "http://127.0.0.1"), init);
}

function isHopByHopHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "connection" ||
    normalized === "keep-alive" ||
    normalized === "transfer-encoding" ||
    normalized === "upgrade"
  );
}

async function sendResponse(request: IncomingMessage, response: ServerResponse, value: Response): Promise<void> {
  const headers = Object.fromEntries(value.headers.entries());
  const body = value.body ? Buffer.from(await value.arrayBuffer()) : Buffer.alloc(0);
  response.writeHead(value.status, {
    "Content-Length": String(body.byteLength),
    ...headers,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function safeErrorCode(cause: unknown): string {
  if (!(cause instanceof Error) || !("code" in cause)) return "unknown";
  const code = cause.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : "unknown";
}

function writeInfo(event: string, fields: Readonly<Record<string, string | number | boolean>> = {}): void {
  // Machine-readable: runtime logs contain only fixed event names and non-secret status metadata.
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), level: "info", component: COMPONENT, event, ...fields })}\n`,
  );
}

function writeError(event: string, fields: Readonly<Record<string, string | readonly string[]>> = {}): void {
  // Machine-readable: never include raw exceptions, paths, request values, or environment values.
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), level: "error", component: COMPONENT, event, ...fields })}\n`,
  );
}

await startSelfHostedRuntime();
