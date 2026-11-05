import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, type Server as TcpServer, type Socket as TcpSocket } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createServer as createTlsServer, type TLSSocket, type Server as TlsServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Schema } from "effect";
import { createSelfHostedEmailCodeDelivery, createSelfHostedSmtpConnector } from "../src/self-hosted/email-delivery";
import {
  initializeNewSelfHostedAuthDatabase,
  readSelfHostedAuthMigrations,
  SELF_HOSTED_AUTH_MIGRATION_FILES,
  SELF_HOSTED_MIGRATION_TABLE,
  SelfHostedSchemaError,
} from "../src/self-hosted/schema";
import { openSqliteD1Database, SqliteD1Database } from "../src/self-hosted/sqlite-d1";
import { D1AuthRepository } from "../src/server/d1-auth-repository";
import { type SmtpConnector, sendPrivateEmailCode } from "../src/server/smtp-email-delivery";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDirectory = resolve(appDirectory, "../..");
const entryPath = join(appDirectory, "src/self-hosted/entry.ts");
const databaseRoot = join(rootDirectory, ".openbot-build/011-self-hosted");
const artifactPath = join(rootDirectory, ".openbot-build/011-gateway-e2e.json");
const smtpArtifactPath = join(rootDirectory, ".openbot-build/011-gateway-smtp-e2e.json");
const TASK_NAME = "plan011-phase2-self-hosted-auth-http";
const MIGRATION_ROW_SCHEMA = Schema.Struct({ migration_name: Schema.String, sha256: Schema.String });
const DECODE_MIGRATION_ROW = Schema.decodeUnknownSync(MIGRATION_ROW_SCHEMA);
const CHALLENGE_AUDIT_SCHEMA = Schema.Struct({ source_ip_hash: Schema.String });
const DECODE_CHALLENGE_AUDIT = Schema.decodeUnknownSync(CHALLENGE_AUDIT_SCHEMA);
const REMOTE_SESSION_AUDIT_SCHEMA = Schema.Struct({ ended_at: Schema.NullOr(Schema.Number) });
const DECODE_REMOTE_SESSION_AUDIT = Schema.decodeUnknownSync(REMOTE_SESSION_AUDIT_SCHEMA);
const OUTBOX_AUDIT_SCHEMA = Schema.Struct({ payload: Schema.String, attempts: Schema.Number });
const DECODE_OUTBOX_AUDIT = Schema.decodeUnknownSync(OUTBOX_AUDIT_SCHEMA);
const SELF_HOSTED_E2E_ENVIRONMENT_TO_CLEAR = [
  "OPENBOT_SELF_HOSTED_HOST",
  "OPENBOT_SELF_HOSTED_PORT",
  "OPENBOT_SELF_HOSTED_DATABASE_PATH",
  "OPENBOT_SELF_HOSTED_MODE",
  "OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE",
  "OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK",
  "OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS",
  "OPENBOT_SELF_HOSTED_TICKET_KEY_ID",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USERNAME",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_FROM",
  "EMAIL_LICENSE_FROM",
  "EMAIL_RELAY",
  "EMAIL_DELIVERY_WEBHOOK_URL",
  "EMAIL_DELIVERY_WEBHOOK_SECRET",
  "AUTH_EXPOSE_DEVELOPMENT_CODE",
  "REMOTE_TICKET_PRIVATE_JWK",
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_TICKET_KEY_ID",
  "OPENBOT_PLAN011_SMTP_FIXTURE_HOST",
  "OPENBOT_PLAN011_SMTP_FIXTURE_PORT",
  "OPENBOT_PLAN011_SMTP_FIXTURE_MODE",
] as const;

type Check = "pending" | "passed";

interface GatewayE2EReport {
  schemaVersion: number;
  task: string;
  startedAt: string;
  finishedAt?: string;
  result?: "passed" | "failed";
  failure?: string;
  phase?: string;
  checks: {
    explicitInitializationAndHashLedger: Check;
    sqliteRepositoryAndBatch: Check;
    missingSchemaFailsClosed: Check;
    tamperedLogoutTriggerFailsClosed: Check;
    missingTicketKeysFailsClosed: Check;
    missingSmtpFailsClosed: Check;
    invalidSmtpFailsClosed: Check;
    nodeSmtpTlsAdapter: Check;
    loopbackDevelopmentCode: Check;
    fiveAuthRoutes: Check;
    bodyLimitAndSourceIp: Check;
    logoutRevokesRemoteSessionAndQueuesOutbox: Check;
    badConfigFailsBeforeOpen: Check;
    gracefulShutdown: Check;
  };
  coverage: {
    runtimeRoutes: readonly string[];
    repositoryCompatibilityFixture: string;
    smtpFixture: string;
  };
  runtime: { node: string; sqlite: string };
  http: {
    port: number;
    livenessStatus: number;
    uninitializedReadinessStatus: number;
    missingKeysReadinessStatus: number;
    missingSmtpReadinessStatus: number;
    invalidSmtpReadinessStatus: number;
    developmentReadinessStatus: number;
    startStatus: number;
    verifyStatus: number;
    meStatus: number;
    logoutStatus: number;
    jwksStatus: number;
    invalidJsonStatus: number;
    oversizedJsonStatus: number;
    readyChunkedOversizedJsonStatus: number;
    unavailableChunkedOversizedJsonStatus: number;
    methodRejectedChunkedOversizedJsonStatus: number;
  };
  process: {
    badConfigExitCode: number | null;
    nonLoopbackDevelopmentExitCode: number | null;
    gracefulShutdownSignal: string;
    gracefulShutdownExitCode: number | null;
  };
  smtp: {
    validTlsSend: boolean;
    invalidCaRejected: boolean;
    hostnameMismatchRejected: boolean;
    aggregateResponseLimitRejected: boolean;
    responseLineLimitRejected: boolean;
    peerCloseBeforeHandshakeRejected: boolean;
    peerCloseBeforeHandshakeMs: number;
  };
}

interface RuntimeLogEvent {
  event: string;
  port?: number;
}

interface ReadyResponse {
  ready: boolean;
  checks: {
    sqlite: string;
    schema: string;
    ticketSigning: string;
    emailDelivery: string;
    companySignIn: string;
    authApi: string;
  };
}

interface AuthStartResponse {
  challengeId: string;
  developmentCode?: string;
}

interface AuthVerifyResponse {
  sessionToken: string;
  user: { id: string; email: string };
}

interface ErrorResponse {
  error: { code: string; message?: string };
}

const report: GatewayE2EReport = {
  schemaVersion: 3,
  task: TASK_NAME,
  startedAt: new Date().toISOString(),
  checks: {
    explicitInitializationAndHashLedger: "pending",
    sqliteRepositoryAndBatch: "pending",
    missingSchemaFailsClosed: "pending",
    tamperedLogoutTriggerFailsClosed: "pending",
    missingTicketKeysFailsClosed: "pending",
    missingSmtpFailsClosed: "pending",
    invalidSmtpFailsClosed: "pending",
    nodeSmtpTlsAdapter: "pending",
    loopbackDevelopmentCode: "pending",
    fiveAuthRoutes: "pending",
    bodyLimitAndSourceIp: "pending",
    logoutRevokesRemoteSessionAndQueuesOutbox: "pending",
    badConfigFailsBeforeOpen: "pending",
    gracefulShutdown: "pending",
  },
  coverage: {
    runtimeRoutes: [
      "POST /v1/auth/email/start",
      "POST /v1/auth/email/verify",
      "GET /v1/me",
      "POST /v1/auth/logout",
      "GET /.well-known/jwks.json",
    ],
    repositoryCompatibilityFixture: "0023_hosted_servers.sql on a separate test-only database",
    smtpFixture: "Node TLS adapter with a generated loopback test CA; no external SMTP or email delivery",
  },
  runtime: { node: process.version, sqlite: "unknown" },
  http: {
    port: 0,
    livenessStatus: 0,
    uninitializedReadinessStatus: 0,
    missingKeysReadinessStatus: 0,
    missingSmtpReadinessStatus: 0,
    invalidSmtpReadinessStatus: 0,
    developmentReadinessStatus: 0,
    startStatus: 0,
    verifyStatus: 0,
    meStatus: 0,
    logoutStatus: 0,
    jwksStatus: 0,
    invalidJsonStatus: 0,
    oversizedJsonStatus: 0,
    readyChunkedOversizedJsonStatus: 0,
    unavailableChunkedOversizedJsonStatus: 0,
    methodRejectedChunkedOversizedJsonStatus: 0,
  },
  process: {
    badConfigExitCode: null,
    nonLoopbackDevelopmentExitCode: null,
    gracefulShutdownSignal: "SIGTERM",
    gracefulShutdownExitCode: null,
  },
  smtp: {
    validTlsSend: false,
    invalidCaRejected: false,
    hostnameMismatchRejected: false,
    aggregateResponseLimitRejected: false,
    responseLineLimitRejected: false,
    peerCloseBeforeHandshakeRejected: false,
    peerCloseBeforeHandshakeMs: 0,
  },
};

const runtimeChildren: ChildProcess[] = [];
const e2eAbortController = new AbortController();
let temporaryDirectory: string | null = null;

process.once("SIGINT", abortGatewayE2E);
process.once("SIGTERM", abortGatewayE2E);

async function runGatewayE2E(): Promise<void> {
  try {
    assert(!process.versions.bun, "Run this E2E with native Node.js.");
    await mkdir(databaseRoot, { recursive: true });
    temporaryDirectory = await mkdtemp(join(databaseRoot, "gateway-e2e-"));

    await markPhase("fresh migration ledger and repository compatibility fixture");
    const ledgerDatabasePath = join(temporaryDirectory, "ledger.sqlite");
    await initializeNewSelfHostedAuthDatabase(ledgerDatabasePath);
    const repositoryFixturePath = join(temporaryDirectory, "repository-compatibility.sqlite");
    await initializeNewSelfHostedAuthDatabase(repositoryFixturePath);
    await exerciseFreshSchemaAndAuthRepository(ledgerDatabasePath, repositoryFixturePath);
    report.checks.explicitInitializationAndHashLedger = "passed";
    report.checks.sqliteRepositoryAndBatch = "passed";

    await markPhase("missing schema readiness");
    const emptyDatabasePath = join(temporaryDirectory, "uninitialized.sqlite");
    const emptyRuntime = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
      OPENBOT_SELF_HOSTED_PORT: "0",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: emptyDatabasePath,
    });
    const emptyOrigin = await waitForOrigin(emptyRuntime);
    await markPhase("missing schema: readiness fetch");
    const emptyReadyResponse = await fetchLocal(`${emptyOrigin}/health/ready`);
    const emptyReady = await readReady(emptyReadyResponse);
    await markPhase("missing schema: bearer route rejection");
    const uninitializedAuthResponse = await fetchLocal(`${emptyOrigin}/v1/me`);
    const uninitializedAuthError = await readError(uninitializedAuthResponse);
    assert(
      emptyReadyResponse.status === 503 &&
        !emptyReady.ready &&
        emptyReady.checks.sqlite === "available" &&
        emptyReady.checks.schema === "unavailable" &&
        uninitializedAuthResponse.status === 503 &&
        uninitializedAuthError.error.code === "account_api_not_ready",
      "An uninitialized SQLite file must stay unready and reject every auth route.",
    );
    report.http.uninitializedReadinessStatus = emptyReadyResponse.status;
    report.checks.missingSchemaFailsClosed = "passed";
    await stopRuntime(emptyRuntime);

    await markPhase("tampered logout trigger readiness");
    const tamperedTriggerPath = join(temporaryDirectory, "tampered-trigger.sqlite");
    await initializeNewSelfHostedAuthDatabase(tamperedTriggerPath);
    const tamperedTriggerDatabase = new DatabaseSync(tamperedTriggerPath);
    tamperedTriggerDatabase.exec("DROP TRIGGER auth_session_revokes_remote_sessions");
    tamperedTriggerDatabase.exec(`
      CREATE TRIGGER auth_session_revokes_remote_sessions
      AFTER UPDATE OF revoked_at ON auth_sessions
      WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      BEGIN
        SELECT 1;
      END;
    `);
    tamperedTriggerDatabase.close();
    const tamperedTriggerRuntime = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
      OPENBOT_SELF_HOSTED_PORT: "0",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: tamperedTriggerPath,
    });
    const tamperedTriggerOrigin = await waitForOrigin(tamperedTriggerRuntime);
    const tamperedTriggerReadyResponse = await fetchLocal(`${tamperedTriggerOrigin}/health/ready`);
    const tamperedTriggerReady = await readReady(tamperedTriggerReadyResponse);
    assert(
      tamperedTriggerReadyResponse.status === 503 &&
        !tamperedTriggerReady.ready &&
        tamperedTriggerReady.checks.schema === "unavailable",
      "A live logout trigger that differs from the shipped migration must keep the account service unready.",
    );
    report.checks.tamperedLogoutTriggerFailsClosed = "passed";
    await stopRuntime(tamperedTriggerRuntime);

    await markPhase("missing ticket keys readiness");
    const missingKeysPath = join(temporaryDirectory, "missing-ticket-keys.sqlite");
    await initializeNewSelfHostedAuthDatabase(missingKeysPath);
    const missingKeysRuntime = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
      OPENBOT_SELF_HOSTED_PORT: "0",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: missingKeysPath,
    });
    const missingKeysOrigin = await waitForOrigin(missingKeysRuntime);
    await markPhase("missing keys: readiness fetch");
    const missingKeysReadyResponse = await fetchLocal(`${missingKeysOrigin}/health/ready`);
    const missingKeysReady = await readReady(missingKeysReadyResponse);
    await markPhase("missing keys: JWKS rejection");
    const missingKeysJwks = await fetchLocal(`${missingKeysOrigin}/.well-known/jwks.json`);
    const missingKeysJwksError = await readError(missingKeysJwks);
    assert(
      missingKeysReadyResponse.status === 503 &&
        !missingKeysReady.ready &&
        missingKeysReady.checks.schema === "available" &&
        missingKeysReady.checks.ticketSigning === "not_configured" &&
        missingKeysReady.checks.authApi === "unavailable" &&
        missingKeysJwks.status === 503 &&
        missingKeysJwksError.error.code === "account_api_not_ready",
      "Missing ticket keys must keep the authenticated API unavailable.",
    );
    report.http.missingKeysReadinessStatus = missingKeysReadyResponse.status;
    report.checks.missingTicketKeysFailsClosed = "passed";
    await stopRuntime(missingKeysRuntime);

    const signingConfig = createEphemeralTicketConfig();
    await markPhase("missing SMTP readiness");
    const missingSmtpPath = join(temporaryDirectory, "missing-smtp.sqlite");
    await initializeNewSelfHostedAuthDatabase(missingSmtpPath);
    const missingSmtpRuntime = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
      OPENBOT_SELF_HOSTED_PORT: "0",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: missingSmtpPath,
      ...signingConfig,
    });
    const missingSmtpOrigin = await waitForOrigin(missingSmtpRuntime);
    await markPhase("missing SMTP: readiness fetch");
    const missingSmtpReadyResponse = await fetchLocal(`${missingSmtpOrigin}/health/ready`);
    const missingSmtpReady = await readReady(missingSmtpReadyResponse);
    await markPhase("missing SMTP: sign-in rejection");
    const missingSmtpStart = await postJson(`${missingSmtpOrigin}/v1/auth/email/start`, {
      email: "nobody@example.invalid",
    });
    const missingSmtpStartError = await readError(missingSmtpStart);
    await markPhase("missing SMTP: chunked body limit");
    const missingSmtpChunkedStart = await postChunkedJson(`${missingSmtpOrigin}/v1/auth/email/start`, {
      email: `${"x".repeat(16_384)}@example.invalid`,
    });
    const missingSmtpChunkedError = await readError(missingSmtpChunkedStart);
    assert(
      missingSmtpReadyResponse.status === 503 &&
        !missingSmtpReady.ready &&
        missingSmtpReady.checks.ticketSigning === "available" &&
        missingSmtpReady.checks.emailDelivery === "not_configured" &&
        missingSmtpReady.checks.authApi === "unavailable" &&
        missingSmtpStart.status === 503 &&
        missingSmtpStartError.error.code === "account_api_not_ready" &&
        missingSmtpChunkedStart.status === 413 &&
        missingSmtpChunkedError.error.code === "request_too_large",
      "Missing SMTP settings must keep the account API unready and reject sign-in.",
    );
    report.http.missingSmtpReadinessStatus = missingSmtpReadyResponse.status;
    report.http.unavailableChunkedOversizedJsonStatus = missingSmtpChunkedStart.status;
    report.checks.missingSmtpFailsClosed = "passed";
    await stopRuntime(missingSmtpRuntime);

    await markPhase("invalid SMTP readiness");
    const invalidSmtpPath = join(temporaryDirectory, "invalid-smtp.sqlite");
    await initializeNewSelfHostedAuthDatabase(invalidSmtpPath);
    const invalidSmtpRuntime = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
      OPENBOT_SELF_HOSTED_PORT: "0",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: invalidSmtpPath,
      EMAIL_SMTP_HOST: "mail.example.invalid",
      ...signingConfig,
    });
    const invalidSmtpOrigin = await waitForOrigin(invalidSmtpRuntime);
    await markPhase("invalid SMTP: readiness fetch");
    const invalidSmtpReadyResponse = await fetchLocal(`${invalidSmtpOrigin}/health/ready`);
    const invalidSmtpReady = await readReady(invalidSmtpReadyResponse);
    await markPhase("invalid SMTP: sign-in rejection");
    const invalidSmtpStart = await postJson(`${invalidSmtpOrigin}/v1/auth/email/start`, {
      email: "nobody@example.invalid",
    });
    const invalidSmtpStartError = await readError(invalidSmtpStart);
    assert(
      invalidSmtpReadyResponse.status === 503 &&
        !invalidSmtpReady.ready &&
        invalidSmtpReady.checks.emailDelivery === "invalid" &&
        invalidSmtpReady.checks.authApi === "unavailable" &&
        invalidSmtpStart.status === 503 &&
        invalidSmtpStartError.error.code === "account_api_not_ready",
      "Partial SMTP settings must not enable the account API.",
    );
    report.http.invalidSmtpReadinessStatus = invalidSmtpReadyResponse.status;
    report.checks.invalidSmtpFailsClosed = "passed";
    await stopRuntime(invalidSmtpRuntime);

    await markPhase("verified Node TLS SMTP loopback fixture");
    await exerciseNodeSmtpTlsAdapter(temporaryDirectory);
    report.checks.nodeSmtpTlsAdapter = "passed";

    await markPhase("five-route local HTTP flow");
    const authDatabasePath = join(temporaryDirectory, "auth-flow.sqlite");
    await initializeNewSelfHostedAuthDatabase(authDatabasePath);
    await exerciseAuthenticatedHttpFlow(authDatabasePath, signingConfig);
    report.checks.loopbackDevelopmentCode = "passed";
    report.checks.fiveAuthRoutes = "passed";
    report.checks.bodyLimitAndSourceIp = "passed";
    report.checks.logoutRevokesRemoteSessionAndQueuesOutbox = "passed";

    await markPhase("invalid configuration rejects before SQLite open");
    const badConfigDatabasePath = join(temporaryDirectory, "bad-config-must-not-open.sqlite");
    const invalidConfig = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
      OPENBOT_SELF_HOSTED_PORT: "not-a-port",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: badConfigDatabasePath,
    });
    const badConfigExit = await invalidConfig.waitForExit();
    assert(
      badConfigExit.code === 1 &&
        invalidConfig.stderrText.includes("OPENBOT_SELF_HOSTED_PORT") &&
        !invalidConfig.stderrText.includes("not-a-port") &&
        !(await fileExists(badConfigDatabasePath)),
      "Invalid listener settings must fail before opening SQLite and omit supplied values from logs.",
    );
    report.process.badConfigExitCode = badConfigExit.code;
    report.checks.badConfigFailsBeforeOpen = "passed";

    await markPhase("non-loopback development-code rejection");
    const nonLoopbackDatabasePath = join(temporaryDirectory, "dev-code-must-not-open.sqlite");
    const nonLoopback = spawnRuntime({
      OPENBOT_SELF_HOSTED_HOST: "0.0.0.0",
      OPENBOT_SELF_HOSTED_PORT: "0",
      OPENBOT_SELF_HOSTED_DATABASE_PATH: nonLoopbackDatabasePath,
      OPENBOT_SELF_HOSTED_MODE: "development",
      OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE: "true",
    });
    const nonLoopbackExit = await nonLoopback.waitForExit();
    assert(
      nonLoopbackExit.code === 1 &&
        nonLoopback.stderrText.includes("OPENBOT_SELF_HOSTED_HOST") &&
        !(await fileExists(nonLoopbackDatabasePath)),
      "Development codes must not be enabled when the listener is not loopback.",
    );
    report.process.nonLoopbackDevelopmentExitCode = nonLoopbackExit.code;

    report.finishedAt = new Date().toISOString();
    report.result = "passed";
    await writeReport();
    process.stdout.write(`{"task":"${TASK_NAME}","result":"passed"}\n`);
  } catch (cause) {
    report.finishedAt = new Date().toISOString();
    report.result = "failed";
    report.failure = errorSummary(cause);
    await writeReport();
    process.stderr.write(`{"task":"${TASK_NAME}","result":"failed"}\n`);
    process.exitCode = 1;
  } finally {
    for (const child of runtimeChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        try {
          await waitForChildExit(child);
        } catch {
          child.kill("SIGKILL");
          await waitForChildExit(child).catch(() => undefined);
        }
      }
    }
    if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function abortGatewayE2E(): void {
  process.exitCode = 1;
  e2eAbortController.abort();
}

async function markPhase(phase: string): Promise<void> {
  report.phase = phase;
  await writeReport();
}

async function writeReport(): Promise<void> {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function exerciseFreshSchemaAndAuthRepository(
  databasePath: string,
  repositoryFixturePath: string,
): Promise<void> {
  const expectedMigrations = readSelfHostedAuthMigrations();
  assert(
    expectedMigrations.length === SELF_HOSTED_AUTH_MIGRATION_FILES.length &&
      expectedMigrations.every((migration, index) => migration.name === SELF_HOSTED_AUTH_MIGRATION_FILES[index]),
    "The local schema must use the explicit full-filename allowlist.",
  );

  const ledgerConnection = new DatabaseSync(databasePath);
  const sqliteVersionRow = ledgerConnection.prepare("SELECT sqlite_version() AS version").get();
  report.runtime.sqlite = typeof sqliteVersionRow?.version === "string" ? sqliteVersionRow.version : "unknown";
  const ledgerDatabase = new SqliteD1Database(ledgerConnection);
  const ledger = await ledgerDatabase
    .prepare(`SELECT migration_name, sha256 FROM ${SELF_HOSTED_MIGRATION_TABLE} ORDER BY migration_name`)
    .all(DECODE_MIGRATION_ROW);
  assert(
    ledger.results.length === expectedMigrations.length &&
      ledger.results.every(
        (row, index) =>
          row.migration_name === expectedMigrations[index]?.name && row.sha256 === expectedMigrations[index]?.sha256,
      ),
    "The fresh database ledger must record each allowed migration filename and exact content hash.",
  );
  ledgerDatabase.close();

  let existingFileRejected = false;
  try {
    await initializeNewSelfHostedAuthDatabase(databasePath);
  } catch (cause) {
    existingFileRejected = cause instanceof SelfHostedSchemaError && cause.code === "schema_unsupported";
  }
  assert(existingFileRejected, "Initialization must reject an existing database file.");

  const rawDatabase = new DatabaseSync(repositoryFixturePath);
  const hostedServersMigration = await readFile(join(appDirectory, "migrations/0023_hosted_servers.sql"), "utf8");
  rawDatabase.exec(hostedServersMigration);
  rawDatabase.exec("CREATE TABLE plan011_batch_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)");
  const database = new SqliteD1Database(rawDatabase);
  const repository = new D1AuthRepository(database);
  const now = Date.now();
  const idHash = `plan011-${randomUUID()}`;
  const token = `plan011-${randomUUID()}`;
  const sessionId = randomUUID();
  const created = await repositoryStep(
    "create challenge",
    Effect.runPromise(
      repository.createEmailChallenge({
        idHash,
        email: "adapter@example.invalid",
        codeHash: "adapter-code-hash",
        sourceIpHash: "loopback-adapter",
        createdAt: now,
        expiresAt: now + 60_000,
        maxAttempts: 4,
      }),
    ),
  );
  assert(created, "The real auth repository must create a challenge through the narrow SQLite D1 port.");
  await repositoryStep(
    "complete challenge delivery",
    Effect.runPromise(repository.completeEmailChallengeDelivery(idHash, "sent", now)),
  );
  const verified = await repositoryStep(
    "verify challenge and register session",
    Effect.runPromise(
      repository.verifyEmailChallenge({
        idHash,
        codeHash: "adapter-code-hash",
        now: now + 1,
        session: { id: sessionId, token, expiresAt: now + 60 * 60_000 },
        device: { id: "plan011-device", name: "Local E2E device", platform: "unknown" },
      }),
    ),
  );
  assert(verified.status === "verified", "The auth repository must finish its verification transaction.");
  const accountSessions = await repositoryStep(
    "list authenticated sessions",
    Effect.runPromise(repository.listAccountSessions(verified.session.user.id, token, now + 2)),
  );
  assert(
    accountSessions.length === 1 && accountSessions[0]?.current === true && accountSessions[0]?.kind === "mobile",
    "The account-session query must return the newly authenticated mobile session.",
  );

  const probe = `plan011-${randomUUID()}`;
  let batchRejected = false;
  try {
    await database.batch([
      database.prepare("INSERT INTO plan011_batch_probe(value) VALUES (?)").bind(probe),
      database.prepare("INSERT INTO plan011_batch_probe(value) VALUES (?)").bind(probe),
    ]);
  } catch {
    batchRejected = true;
  }
  const rollbackCount = await database
    .prepare("SELECT count(*) AS count FROM plan011_batch_probe")
    .first(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number })));
  assert(batchRejected && rollbackCount?.count === 0, "A failed D1 batch must roll back its earlier writes.");
  database.close();
}

type SmtpFixtureBehavior = "normal" | "aggregate_reply_limit" | "reply_line_limit";

interface LocalSmtpFixture {
  port: number;
  stats: { messages: number };
  close(): Promise<void>;
}

async function exerciseNodeSmtpTlsAdapter(
  directory: string,
  onProgress?: (phase: string) => void | Promise<void>,
): Promise<void> {
  const relayConfig = {
    host: "localhost",
    port: 465,
    username: "fixture@example.invalid",
    password: "fixture-only-password",
    from: "fixture@example.invalid",
    relay: { fetch: async () => new Response(null, { status: 200 }) },
  };
  let relayRejected = false;
  try {
    createSelfHostedEmailCodeDelivery(relayConfig);
  } catch {
    relayRejected = true;
  }
  assert(relayRejected, "The Node SMTP boundary must reject the Worker email relay option.");

  const material = await createLocalTlsMaterial(directory);
  const normalFixture = await startLocalSmtpFixture(material.key, material.certificate, "normal");
  try {
    await onProgress?.("valid TLS send");
    const sent = await runSmtpTlsFixtureClient(normalFixture.port, "localhost", "send", material.trustBundle);
    assert(
      sent.result === "sent" && normalFixture.stats.messages === 1,
      "The verified Node TLS adapter must send one local SMTP message.",
    );
    report.smtp.validTlsSend = true;

    const invalidCa = await runSmtpTlsFixtureClient(normalFixture.port, "localhost", "send");
    await onProgress?.("untrusted CA rejection");
    assert(
      invalidCa.result !== "sent" && normalFixture.stats.messages === 1,
      "The Node TLS adapter must reject a CA that is not trusted.",
    );
    report.smtp.invalidCaRejected = true;
  } finally {
    await normalFixture.close();
  }

  const mismatchFixture = await startLocalSmtpFixture(material.key, material.mismatchCertificate, "normal");
  try {
    await onProgress?.("hostname mismatch rejection");
    const hostnameMismatch = await runSmtpTlsFixtureClient(
      mismatchFixture.port,
      "localhost",
      "send",
      material.trustBundle,
    );
    assert(
      hostnameMismatch.result !== "sent" && mismatchFixture.stats.messages === 0,
      `The Node TLS adapter must reject a hostname mismatch (result=${hostnameMismatch.result}, messages=${mismatchFixture.stats.messages}).`,
    );
    report.smtp.hostnameMismatchRejected = true;
  } finally {
    await mismatchFixture.close();
  }

  const aggregateFixture = await startLocalSmtpFixture(material.key, material.certificate, "aggregate_reply_limit");
  try {
    await onProgress?.("aggregate SMTP reply limit");
    const result = await runSmtpTlsFixtureClient(aggregateFixture.port, "localhost", "send", material.trustBundle);
    assert(
      result.result === "smtp_response_too_large",
      "The SMTP parser must cap the total bytes in a multiline reply.",
    );
    report.smtp.aggregateResponseLimitRejected = true;
  } finally {
    await aggregateFixture.close();
  }

  const lineFixture = await startLocalSmtpFixture(material.key, material.certificate, "reply_line_limit");
  try {
    await onProgress?.("SMTP reply line limit");
    const result = await runSmtpTlsFixtureClient(lineFixture.port, "localhost", "send", material.trustBundle);
    assert(result.result === "smtp_response_too_large", "The SMTP parser must cap the number of lines in a reply.");
    report.smtp.responseLineLimitRejected = true;
  } finally {
    await lineFixture.close();
  }

  const peerClosed = await runPeerCloseBeforeTlsFixture();
  await onProgress?.("peer closes before TLS handshake");
  assert(
    peerClosed.result === "rejected" && peerClosed.elapsedMs < 1_500,
    "The TLS opened promise must reject promptly when the peer closes before the handshake.",
  );
  report.smtp.peerCloseBeforeHandshakeRejected = true;
  report.smtp.peerCloseBeforeHandshakeMs = peerClosed.elapsedMs;
}

interface LocalTlsMaterial {
  key: Buffer;
  certificate: Buffer;
  mismatchCertificate: Buffer;
  trustBundle: string;
}

async function createLocalTlsMaterial(directory: string): Promise<LocalTlsMaterial> {
  const caKeyPath = join(directory, "smtp-test-ca.key");
  const caCertificatePath = join(directory, "smtp-test-ca.crt");
  const serverKeyPath = join(directory, "smtp-test-server.key");
  const serverRequestPath = join(directory, "smtp-test-server.csr");
  const mismatchRequestPath = join(directory, "smtp-test-mismatch-server.csr");
  const serverCertificatePath = join(directory, "smtp-test-server.crt");
  const mismatchCertificatePath = join(directory, "smtp-test-mismatch-server.crt");
  const extensionPath = join(directory, "smtp-test-server.ext");
  const mismatchExtensionPath = join(directory, "smtp-test-mismatch-server.ext");
  const trustBundlePath = join(directory, "smtp-test-ca-bundle.crt");

  runOpenSsl(directory, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKeyPath,
    "-out",
    caCertificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=Plan011LocalSmtpTestCA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl(directory, [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKeyPath,
    "-out",
    serverRequestPath,
    "-subj",
    "/CN=localhost",
  ]);
  runOpenSsl(directory, [
    "req",
    "-new",
    "-key",
    serverKeyPath,
    "-out",
    mismatchRequestPath,
    "-subj",
    "/CN=wrong.invalid",
  ]);
  await writeFile(
    extensionPath,
    "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    "utf8",
  );
  runOpenSsl(directory, [
    "x509",
    "-req",
    "-in",
    serverRequestPath,
    "-CA",
    caCertificatePath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    serverCertificatePath,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    extensionPath,
  ]);
  await writeFile(
    mismatchExtensionPath,
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    "utf8",
  );
  runOpenSsl(directory, [
    "x509",
    "-req",
    "-in",
    mismatchRequestPath,
    "-CA",
    caCertificatePath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    mismatchCertificatePath,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    mismatchExtensionPath,
  ]);

  const inheritedExtraCa = process.env.NODE_EXTRA_CA_CERTS;
  const inheritedExtraCaContents = inheritedExtraCa ? await readFile(inheritedExtraCa, "utf8") : "";
  const testCaContents = await readFile(caCertificatePath, "utf8");
  await writeFile(trustBundlePath, `${inheritedExtraCaContents}\n${testCaContents}`, "utf8");
  return {
    key: await readFile(serverKeyPath),
    certificate: await readFile(serverCertificatePath),
    mismatchCertificate: await readFile(mismatchCertificatePath),
    trustBundle: trustBundlePath,
  };
}

function runOpenSsl(directory: string, args: readonly string[]): void {
  const result = spawnSync("openssl", [...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("The local SMTP TLS certificate fixture failed to start.");
}

async function startLocalSmtpFixture(
  key: Buffer,
  certificate: Buffer,
  behavior: SmtpFixtureBehavior,
): Promise<LocalSmtpFixture> {
  const stats = { messages: 0 };
  const sockets = new Set<TcpSocket>();
  const tlsSockets = new Set<TLSSocket>();
  const servers: TlsServer[] = [];
  const createFixtureServer = () => {
    const server = createTlsServer({ key, cert: certificate }, (socket) => {
      if (behavior === "aggregate_reply_limit") {
        const longLines = Array.from({ length: 80 }, () => `250-${"x".repeat(250)}\r\n`).join("");
        socket.write(`${longLines}250 done\r\n`);
        return;
      }
      if (behavior === "reply_line_limit") {
        const shortLines = Array.from({ length: 101 }, () => "250-x\r\n").join("");
        socket.write(`${shortLines}250 done\r\n`);
        return;
      }
      serveLocalSmtpConversation(socket, stats);
    });
    server.on("connection", (socket: TcpSocket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("secureConnection", (socket: TLSSocket) => {
      tlsSockets.add(socket);
      socket.once("close", () => tlsSockets.delete(socket));
    });
    server.on("tlsClientError", () => {});
    return server;
  };

  const server = createFixtureServer();
  servers.push(server);
  await listenLocalTlsServer(server, 0, "127.0.0.1");
  const address = server.address();
  assert(address !== null && typeof address !== "string", "The SMTP fixture must bind to a local IPv4 address.");
  const port = address.port;

  return {
    port,
    stats,
    async close() {
      for (const socket of tlsSockets) socket.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => closeLocalServer(server)));
    },
  };
}

function listenLocalTlsServer(server: TlsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      try {
        server.close();
      } catch {
        // The listener may not have started.
      }
      reject(new Error("The local SMTP TLS server did not start in time."));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host });
  });
}

async function closeLocalServer(server: TcpServer): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      server.close((cause) => (cause ? reject(cause) : resolve()));
    }),
    rejectAfter(5_000, "The local SMTP fixture server did not close in time."),
  ]);
}

function serveLocalSmtpConversation(socket: TLSSocket, stats: { messages: number }): void {
  let buffer = "";
  let readingMessage = false;
  socket.write("220 local SMTP fixture\r\n");
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      if (readingMessage) {
        const terminator = buffer.indexOf("\r\n.\r\n");
        if (terminator < 0) return;
        buffer = buffer.slice(terminator + 5);
        readingMessage = false;
        stats.messages += 1;
        socket.write("250 2.0.0 queued\r\n");
        continue;
      }
      const lineEnd = buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      if (line.startsWith("EHLO")) socket.write("250-local SMTP fixture\r\n250 AUTH PLAIN\r\n");
      else if (line.startsWith("AUTH PLAIN")) socket.write("235 2.7.0 authenticated\r\n");
      else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 2.1.0 accepted\r\n");
      else if (line === "DATA") {
        readingMessage = true;
        socket.write("354 send message\r\n");
      } else if (line === "QUIT") {
        socket.end("221 2.0.0 bye\r\n");
        return;
      } else {
        socket.write("500 command rejected\r\n");
      }
    }
  });
}

async function runSmtpTlsFixtureClient(
  port: number,
  host: string,
  mode: "send",
  trustBundle?: string,
): Promise<{ result: string }> {
  return runSmtpFixtureChild({
    OPENBOT_PLAN011_SMTP_FIXTURE_HOST: host,
    OPENBOT_PLAN011_SMTP_FIXTURE_MODE: mode,
    OPENBOT_PLAN011_SMTP_FIXTURE_PORT: String(port),
    ...(trustBundle ? { NODE_EXTRA_CA_CERTS: trustBundle } : {}),
  });
}

async function runPeerCloseBeforeTlsFixture(): Promise<{ result: string; elapsedMs: number }> {
  let connections = 0;
  const sockets = new Set<TcpSocket>();
  const server: TcpServer = createTcpServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off("error", onError);
      reject(new Error("The local pre-TLS server did not start in time."));
    }, 5_000);
    const onError = (cause: Error) => {
      clearTimeout(timeout);
      reject(cause);
    };
    const onListening = () => {
      clearTimeout(timeout);
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", onListening);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string", "The pre-TLS close fixture must bind to a local port.");
  try {
    const result = await runSmtpFixtureChild({
      OPENBOT_PLAN011_SMTP_FIXTURE_HOST: "127.0.0.1",
      OPENBOT_PLAN011_SMTP_FIXTURE_MODE: "open",
      OPENBOT_PLAN011_SMTP_FIXTURE_PORT: String(address.port),
    });
    assert(connections > 0, "The pre-TLS close fixture must accept a loopback TCP connection.");
    assert(typeof result.elapsedMs === "number", "The pre-TLS close fixture must report elapsed time.");
    return { result: result.result, elapsedMs: result.elapsedMs };
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeLocalServer(server);
  }
}

async function runSmtpFixtureChild(
  values: Readonly<Record<string, string>>,
): Promise<{ result: string; elapsedMs?: number }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--smtp-tls-fixture-client"],
    {
      cwd: appDirectory,
      env: gatewayE2EEnvironment(values),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  runtimeChildren.push(child);
  child.once("error", () => {});
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
  });
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < 4_096) stdout += chunk.slice(0, 4_096 - stdout.length);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const closeResult = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The local SMTP TLS fixture client timed out.")), 12_000);
      }),
    ]);
    assert(
      closeResult.code === 0,
      `The local SMTP TLS fixture client must report a result (code=${closeResult.code}, signal=${closeResult.signal ?? "none"}, stderr=${stderr.trim().slice(-500) || "empty"}).`,
    );
    const output = stdout.trim().split("\n").at(-1);
    const parsed = output ? JSON.parse(output) : null;
    assert(
      isDynamicRecord(parsed) && typeof parsed.result === "string",
      "The local SMTP TLS fixture client must return a safe result code.",
    );
    return {
      result: parsed.result,
      ...(typeof parsed.elapsedMs === "number" ? { elapsedMs: parsed.elapsedMs } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}

async function runSmtpTlsFixtureClientProcess(): Promise<void> {
  try {
    const rawPort = process.env.OPENBOT_PLAN011_SMTP_FIXTURE_PORT ?? "";
    const port = Number(rawPort);
    const host = process.env.OPENBOT_PLAN011_SMTP_FIXTURE_HOST ?? "";
    const mode = process.env.OPENBOT_PLAN011_SMTP_FIXTURE_MODE;
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535 || !["localhost", "127.0.0.1"].includes(host)) {
      throw new Error("invalid_fixture_settings");
    }
    const connector = createSelfHostedSmtpConnector();
    if (mode === "open") {
      const startedAt = Date.now();
      const socket = connector({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
      let result = "opened";
      try {
        await Promise.race([socket.opened, rejectAfter(3_000, "The TLS fixture handshake timed out.")]);
      } catch {
        result = "rejected";
      } finally {
        await socket.close();
      }
      process.stdout.write(`${JSON.stringify({ result, elapsedMs: Date.now() - startedAt })}\n`);
      return;
    }
    if (mode !== "send") throw new Error("invalid_fixture_mode");
    const testConfig = {
      host,
      port: 465,
      username: "fixture@example.invalid",
      password: "fixture-only-password",
      from: "fixture@example.invalid",
    };
    const mappedConnector: SmtpConnector = (
      address: { hostname: string; port: number },
      options: { secureTransport: "on"; allowHalfOpen: false },
    ) => {
      if (address.port !== 465) throw new Error("smtp_fixture_port_invalid");
      return connector({ hostname: address.hostname, port }, options);
    };
    const result = await Effect.runPromise(
      Effect.result(
        sendPrivateEmailCode(
          testConfig,
          { email: "recipient@example.invalid", code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 },
          mappedConnector,
        ),
      ),
    );
    const resultCode = Result.isSuccess(result) ? "sent" : safeSmtpFailureCode(result.failure);
    process.stdout.write(`${JSON.stringify({ result: resultCode })}\n`);
  } catch {
    process.stderr.write("The local SMTP TLS fixture client failed.\n");
    process.exitCode = 1;
  }
}

function safeSmtpFailureCode(error: { message: string }): string {
  return /^smtp_[a-z_]+$/u.test(error.message) ? error.message : "smtp_transport_failed";
}

async function repositoryStep<A>(name: string, operation: Promise<A>): Promise<A> {
  try {
    return await operation;
  } catch {
    throw new Error(`The SQLite auth repository failed during ${name}.`);
  }
}

async function exerciseAuthenticatedHttpFlow(
  databasePath: string,
  signingConfig: Readonly<Record<string, string>>,
): Promise<void> {
  const runtime = spawnRuntime({
    OPENBOT_SELF_HOSTED_HOST: "127.0.0.1",
    OPENBOT_SELF_HOSTED_PORT: "0",
    OPENBOT_SELF_HOSTED_DATABASE_PATH: databasePath,
    OPENBOT_SELF_HOSTED_MODE: "development",
    OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE: "true",
    ...signingConfig,
  });
  const origin = await waitForOrigin(runtime);

  await markPhase("http liveness");
  const liveResponse = await fetchLocal(`${origin}/health/live`);
  const liveBody = await readObject(liveResponse);
  assert(liveResponse.status === 200 && liveBody.status === "live", "The local runtime must report liveness.");
  report.http.livenessStatus = liveResponse.status;

  await markPhase("http ready with local development code");
  const readyResponse = await fetchLocal(`${origin}/health/ready`);
  const ready = await readReady(readyResponse);
  assert(
    readyResponse.status === 200 &&
      ready.ready &&
      ready.checks.schema === "available" &&
      ready.checks.ticketSigning === "available" &&
      ready.checks.emailDelivery === "development_code" &&
      ready.checks.authApi === "available",
    "Loopback development-code mode with a fresh schema and matching ticket keys must be ready.",
  );
  report.http.developmentReadinessStatus = readyResponse.status;

  await markPhase("http method contract");
  const wrongMethod = await fetchLocal(`${origin}/v1/auth/email/start`);
  const wrongMethodBody = await readError(wrongMethod);
  assert(
    wrongMethod.status === 405 &&
      wrongMethod.headers.get("Allow") === "POST" &&
      wrongMethodBody.error.message === "The request method is not allowed.",
    "A method error must keep the shared account API status, message, and Allow header.",
  );

  await markPhase("http malformed JSON");
  const invalidJson = await fetchLocal(`${origin}/v1/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  const invalidJsonBody = await readError(invalidJson);
  assert(
    invalidJson.status === 400 && invalidJsonBody.error.code === "invalid_json",
    "The shared HTTP boundary must preserve malformed-JSON errors.",
  );
  report.http.invalidJsonStatus = invalidJson.status;

  await markPhase("http JSON body limit");
  const oversizedJson = await fetchLocal(`${origin}/v1/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${"a".repeat(16_384)}@example.invalid` }),
  });
  const oversizedJsonBody = await readError(oversizedJson);
  assert(
    oversizedJson.status === 413 && oversizedJsonBody.error.code === "request_too_large",
    "The account API must reject JSON requests larger than 16 KiB.",
  );
  report.http.oversizedJsonStatus = oversizedJson.status;

  await markPhase("http chunked JSON body limit while ready");
  const readyChunkedOversizedJson = await postChunkedJson(`${origin}/v1/auth/email/start`, {
    email: `${"x".repeat(16_384)}@example.invalid`,
  });
  const readyChunkedOversizedJsonError = await readError(readyChunkedOversizedJson);
  assert(
    readyChunkedOversizedJson.status === 413 && readyChunkedOversizedJsonError.error.code === "request_too_large",
    "The ready account API must cap an unknown-length chunked JSON body.",
  );
  report.http.readyChunkedOversizedJsonStatus = readyChunkedOversizedJson.status;

  await markPhase("http chunked JSON body limit before method rejection");
  const methodRejectedChunkedOversizedJson = await postChunkedJson(`${origin}/v1/me`, {
    email: `${"x".repeat(16_384)}@example.invalid`,
  });
  const methodRejectedChunkedOversizedJsonError = await readError(methodRejectedChunkedOversizedJson);
  assert(
    methodRejectedChunkedOversizedJson.status === 413 &&
      methodRejectedChunkedOversizedJsonError.error.code === "request_too_large",
    "The account API must enforce the body cap before returning a method error.",
  );
  report.http.methodRejectedChunkedOversizedJsonStatus = methodRejectedChunkedOversizedJson.status;

  const email = "Plan011-Gateway@example.invalid";
  await markPhase("http email start");
  const startResponse = await postJson(
    `${origin}/v1/auth/email/start`,
    { email },
    {
      "X-Forwarded-For": "198.51.100.77",
    },
  );
  const start = await readStart(startResponse);
  const developmentCode = start.developmentCode;
  assert(
    startResponse.status === 200 &&
      typeof developmentCode === "string" &&
      developmentCode.length > 0 &&
      start.challengeId.length > 0,
    "The local development-code mode must create an email challenge without SMTP.",
  );
  report.http.startStatus = startResponse.status;

  const auditDatabase = openSqliteD1Database(databasePath);
  try {
    const challengeIdHash = hash(start.challengeId);
    const challenge = await auditDatabase
      .prepare("SELECT source_ip_hash FROM email_login_challenges WHERE id_hash = ?")
      .bind(challengeIdHash)
      .first(DECODE_CHALLENGE_AUDIT);
    const localSourceHashes = [hash("127.0.0.1"), hash("::ffff:127.0.0.1")];
    assert(
      challenge !== null &&
        localSourceHashes.includes(challenge.source_ip_hash) &&
        challenge.source_ip_hash !== hash("198.51.100.77"),
      "Rate-limit identity must use the socket peer address and ignore X-Forwarded-For.",
    );
  } finally {
    auditDatabase.close();
  }

  await markPhase("http email verify");
  const verifyResponse = await postJson(`${origin}/v1/auth/email/verify`, {
    challengeId: start.challengeId,
    code: developmentCode,
  });
  const verified = await readVerify(verifyResponse);
  assert(
    verifyResponse.status === 200 &&
      verified.sessionToken.length > 0 &&
      verified.user.email === "plan011-gateway@example.invalid",
    "The shared verify route must return the desktop bearer session and normalized account.",
  );
  report.http.verifyStatus = verifyResponse.status;

  const bearerHeaders = { Authorization: `Bearer ${verified.sessionToken}` };
  await markPhase("http bearer me");
  const meResponse = await fetchLocal(`${origin}/v1/me`, { headers: bearerHeaders });
  const meBody = await readObject(meResponse);
  assert(
    meResponse.status === 200 && meBody.id === verified.user.id && meBody.email === verified.user.email,
    "The bearer `/v1/me` route must return the signed-in account.",
  );
  report.http.meStatus = meResponse.status;

  await markPhase("http public JWKS");
  const jwksResponse = await fetchLocal(`${origin}/.well-known/jwks.json`);
  const jwksBody = await readObject(jwksResponse);
  assert(
    jwksResponse.status === 200 &&
      Array.isArray(jwksBody.keys) &&
      jwksBody.keys.length === 1 &&
      isDynamicRecord(jwksBody.keys[0]) &&
      !("d" in jwksBody.keys[0]),
    "The JWKS route must publish public ticket material only.",
  );
  report.http.jwksStatus = jwksResponse.status;

  const remoteSessionId = randomUUID();
  const hostId = randomUUID();
  const membershipId = randomUUID();
  const now = Date.now();
  const tokenHash = hash(verified.sessionToken);
  const seedDatabase = openSqliteD1Database(databasePath);
  try {
    await seedDatabase
      .prepare(
        `INSERT INTO remote_hosts(host_id, owner_user_id, name, auth_epoch, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .bind(hostId, verified.user.id, "Plan011 E2E Host", now, now)
      .run();
    await seedDatabase
      .prepare(
        `INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
      )
      .bind(membershipId, hostId, verified.user.id, now, now)
      .run();
    await seedDatabase
      .prepare(
        `INSERT INTO remote_sessions(
           session_id, host_id, user_id, membership_id, started_at, ended_at, expires_at, auth_session_hash
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(remoteSessionId, hostId, verified.user.id, membershipId, now, now + 60_000, tokenHash)
      .run();
  } finally {
    seedDatabase.close();
  }

  await markPhase("http bearer logout and outbox trigger");
  const logoutResponse = await fetchLocal(`${origin}/v1/auth/logout`, {
    method: "POST",
    headers: bearerHeaders,
  });
  assert(
    logoutResponse.status === 204 && (await logoutResponse.text()) === "",
    "Logout must return the existing empty 204 response.",
  );
  report.http.logoutStatus = logoutResponse.status;

  await markPhase("http revoked bearer rejected");
  const revokedMe = await fetchLocal(`${origin}/v1/me`, { headers: bearerHeaders });
  const revokedMeBody = await readError(revokedMe);
  assert(
    revokedMe.status === 401 && revokedMeBody.error.code === "unauthorized",
    "A revoked account bearer must no longer authenticate.",
  );

  const logoutAudit = openSqliteD1Database(databasePath);
  try {
    const remoteSession = await logoutAudit
      .prepare("SELECT ended_at FROM remote_sessions WHERE session_id = ?")
      .bind(remoteSessionId)
      .first(DECODE_REMOTE_SESSION_AUDIT);
    const outboxRows = await logoutAudit
      .prepare("SELECT payload, attempts FROM remote_auth_events WHERE json_extract(payload, '$.sessionId') = ?")
      .bind(remoteSessionId)
      .all(DECODE_OUTBOX_AUDIT);
    const event = outboxRows.results[0] ? JSON.parse(outboxRows.results[0].payload) : null;
    assert(
      remoteSession !== null &&
        remoteSession.ended_at !== null &&
        outboxRows.results.length === 1 &&
        outboxRows.results[0]?.attempts === 0 &&
        isDynamicRecord(event) &&
        event.type === "remote-session-ended" &&
        event.hostId === hostId &&
        event.sessionId === remoteSessionId,
      "The account-session UPDATE trigger must end the bound remote session and persist its outbox event.",
    );
  } finally {
    logoutAudit.close();
  }

  await stopRuntime(runtime);
  assert(
    !runtime.stdoutText.includes(developmentCode) &&
      !runtime.stdoutText.includes(verified.sessionToken) &&
      !runtime.stdoutText.includes(email.toLowerCase()) &&
      !runtime.stderrText.includes(developmentCode) &&
      !runtime.stderrText.includes(verified.sessionToken) &&
      !runtime.stderrText.includes(email.toLowerCase()) &&
      !runtime.stdoutText.includes(signingConfig.OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK ?? "") &&
      !runtime.stderrText.includes(signingConfig.OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK ?? ""),
    "Runtime logs must not include development codes, bearer tokens, or private ticket keys.",
  );
  report.http.port = runtime.port;
  report.checks.gracefulShutdown = "passed";
  report.process.gracefulShutdownExitCode = runtime.exitCode;
}

function createEphemeralTicketConfig(): Record<string, string> {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyId = "plan011-e2e-local";
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: keyId };
  return {
    OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK: JSON.stringify(privateJwk),
    OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    OPENBOT_SELF_HOSTED_TICKET_KEY_ID: keyId,
  };
}

async function waitForOrigin(runtime: RuntimeProcess): Promise<string> {
  const listening = await runtime.waitForEvent("listening");
  const port = numberField(listening, "port");
  runtime.port = port;
  return `http://127.0.0.1:${port}`;
}

function spawnRuntime(values: Readonly<Record<string, string>>): RuntimeProcess {
  const child = spawn(process.execPath, ["--import", "tsx", entryPath], {
    env: gatewayE2EEnvironment(values),
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtimeChildren.push(child);
  child.once("error", () => {});
  const runtime = new RuntimeProcess(child);
  return runtime;
}

function gatewayE2EEnvironment(values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SELF_HOSTED_E2E_ENVIRONMENT_TO_CLEAR) delete environment[name];
  Object.assign(environment, values);
  return environment;
}

async function stopRuntime(runtime: RuntimeProcess): Promise<void> {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
    const exit = await runtime.waitForExit();
    assert(exit.code === 0, "The local runtime must stay alive until graceful shutdown.");
    return;
  }
  runtime.child.kill("SIGTERM");
  await markPhase("graceful shutdown of authenticated runtime");
  await runtime.waitForEvent("shutdown_complete");
  const exit = await runtime.waitForExit();
  assert(exit.code === 0, "SIGTERM must close the HTTP server and SQLite connection cleanly.");
  report.process.gracefulShutdownExitCode = exit.code;
  report.checks.gracefulShutdown = "passed";
}

class RuntimeProcess {
  readonly child: ChildProcess;
  port = 0;
  readonly #events = new Map<string, RuntimeLogEvent[]>();
  readonly #waiters = new Map<string, Array<(event: RuntimeLogEvent) => void>>();
  #stdout = "";
  #stderr = "";
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(child: ChildProcess) {
    this.child = child;
    if (!child.stdout || !child.stderr) throw new Error("The local runtime has no captured output streams.");
    this.#exit = new Promise((resolveExit) => {
      child.once("error", () => resolveExit({ code: 1, signal: null }));
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const event = parseLogEvent(line);
      if (event) this.#publish(event);
    });
  }

  get stdoutText(): string {
    return this.#stdout;
  }

  get stderrText(): string {
    return this.#stderr;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  async waitForEvent(name: string): Promise<RuntimeLogEvent> {
    const known = this.#events.get(name)?.shift();
    if (known) return known;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(`The local runtime exited before its ${name} event.`);
    }
    return Promise.race([
      new Promise<RuntimeLogEvent>((resolveEvent) => {
        const waiters = this.#waiters.get(name) ?? [];
        waiters.push(resolveEvent);
        this.#waiters.set(name, waiters);
      }),
      this.#exit.then(() => {
        throw new Error(`The local runtime exited before its ${name} event.`);
      }),
      rejectAfter<RuntimeLogEvent>(10_000, `Timed out waiting for the local runtime ${name} event.`),
    ]);
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return Promise.race([
      this.#exit,
      rejectAfter<{ code: number | null; signal: NodeJS.Signals | null }>(
        10_000,
        "Timed out waiting for the local runtime to exit.",
      ),
    ]);
  }

  #publish(event: RuntimeLogEvent): void {
    const waiters = this.#waiters.get(event.event);
    const waiter = waiters?.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    const events = this.#events.get(event.event) ?? [];
    events.push(event);
    this.#events.set(event.event, events);
  }
}

async function postJson(
  url: string,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetchLocal(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(value),
  });
}

async function postChunkedJson(url: string, value: unknown): Promise<Response> {
  const serialized = new TextEncoder().encode(JSON.stringify(value));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < serialized.byteLength; offset += 4_096) {
        controller.enqueue(serialized.slice(offset, Math.min(offset + 4_096, serialized.byteLength)));
      }
      controller.close();
    },
  });
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  Object.assign(init, { body, duplex: "half" });
  return fetchLocal(url, init);
}

async function fetchLocal(url: string, init: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(8_000);
  const signals = [e2eAbortController.signal, timeout];
  if (init.signal) signals.push(init.signal);
  return fetch(url, {
    ...init,
    signal: AbortSignal.any(signals),
  });
}

async function readObject(response: Response): Promise<DynamicRecord> {
  const value = await response.json();
  assert(isDynamicRecord(value), "The account endpoint must return a JSON object.");
  return value;
}

async function readError(response: Response): Promise<ErrorResponse> {
  const value = await readObject(response);
  assert(
    isDynamicRecord(value.error) && typeof value.error.code === "string",
    "The endpoint must return an API error.",
  );
  return {
    error: {
      code: value.error.code,
      ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
    },
  };
}

async function readReady(response: Response): Promise<ReadyResponse> {
  const value = await readObject(response);
  assert(
    typeof value.ready === "boolean" &&
      isDynamicRecord(value.checks) &&
      typeof value.checks.sqlite === "string" &&
      typeof value.checks.schema === "string" &&
      typeof value.checks.ticketSigning === "string" &&
      typeof value.checks.emailDelivery === "string" &&
      typeof value.checks.companySignIn === "string" &&
      typeof value.checks.authApi === "string",
    "The readiness response must include every dependency status.",
  );
  return {
    ready: value.ready,
    checks: {
      sqlite: value.checks.sqlite,
      schema: value.checks.schema,
      ticketSigning: value.checks.ticketSigning,
      emailDelivery: value.checks.emailDelivery,
      companySignIn: value.checks.companySignIn,
      authApi: value.checks.authApi,
    },
  };
}

async function readStart(response: Response): Promise<AuthStartResponse> {
  const value = await readObject(response);
  assert(typeof value.challengeId === "string", "The email start response must include a challenge ID.");
  assert(
    value.developmentCode === undefined || typeof value.developmentCode === "string",
    "The development code must be a string when exposed.",
  );
  return {
    challengeId: value.challengeId,
    ...(typeof value.developmentCode === "string" ? { developmentCode: value.developmentCode } : {}),
  };
}

async function readVerify(response: Response): Promise<AuthVerifyResponse> {
  const value = await readObject(response);
  assert(
    typeof value.sessionToken === "string" &&
      isDynamicRecord(value.user) &&
      typeof value.user.id === "string" &&
      typeof value.user.email === "string",
    "The email verify response must include the bearer session and account.",
  );
  return {
    sessionToken: value.sessionToken,
    user: { id: value.user.id, email: value.user.email },
  };
}

function parseLogEvent(line: string): RuntimeLogEvent | null {
  try {
    const value = JSON.parse(line);
    if (!isDynamicRecord(value) || typeof value.event !== "string") return null;
    return {
      event: value.event,
      ...(typeof value.port === "number" ? { port: value.port } : {}),
    };
  } catch {
    return null;
  }
}

function numberField(value: RuntimeLogEvent, field: "port"): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    throw new Error(`The runtime ${value.event} event has no valid ${field}.`);
  }
  return candidate;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorSummary(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown E2E failure.";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function rejectAfter<A>(milliseconds: number, message: string): Promise<A> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), milliseconds).unref();
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("Timed out waiting for a local runtime child to exit."));
    }, 10_000);
    timeout.unref();
    child.once("close", onClose);
  });
}

if (process.argv.includes("--smtp-tls-fixture-client")) {
  await runSmtpTlsFixtureClientProcess();
} else if (process.argv.includes("--smtp-tls-fixture-e2e")) {
  await runSmtpTlsFixtureE2E();
} else {
  await runGatewayE2E();
}

async function runSmtpTlsFixtureE2E(): Promise<void> {
  const result: {
    task: string;
    result: "pending" | "passed" | "failed";
    phase?: string;
    failure?: string;
    smtp: GatewayE2EReport["smtp"];
  } = {
    task: `${TASK_NAME}-smtp-fixture`,
    result: "pending",
    smtp: { ...report.smtp },
  };
  let directory: string | null = null;
  const writeSmtpReport = async () => {
    result.smtp = { ...report.smtp };
    await mkdir(dirname(smtpArtifactPath), { recursive: true });
    await writeFile(smtpArtifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  };
  try {
    directory = await mkdtemp(join(databaseRoot, "smtp-fixture-e2e-"));
    await writeSmtpReport();
    await exerciseNodeSmtpTlsAdapter(directory, async (phase) => {
      result.phase = phase;
      await writeSmtpReport();
    });
    result.result = "passed";
  } catch (cause) {
    result.result = "failed";
    result.failure = errorSummary(cause);
    process.exitCode = 1;
  } finally {
    await writeSmtpReport();
    if (directory) await rm(directory, { force: true, recursive: true });
  }
  process.stdout.write(`${JSON.stringify({ task: result.task, result: result.result })}\n`);
}
