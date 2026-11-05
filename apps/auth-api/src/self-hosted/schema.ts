import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import type { AuthD1Database, AuthD1RowDecoder } from "../server/d1-auth-repository";
import { SqliteD1Database } from "./sqlite-d1";

const MIGRATION_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const LOCAL_DATABASE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.openbot-build/011-self-hosted",
);
export const SELF_HOSTED_MIGRATION_TABLE = "openbot_self_hosted_migrations";

/**
 * These migrations are the dependency closure for email auth, desktop-session reads and the
 * existing remote-session logout trigger. Marketplace, hosted-site, billing and license migrations
 * are outside this local runtime's supported schema.
 */
export const SELF_HOSTED_AUTH_MIGRATION_FILES = [
  "0001_google_auth.sql",
  "0002_email_login_codes.sql",
  "0003_remove_google_oauth.sql",
  "0004_team_auth_tickets.sql",
  "0005_team_tunnels.sql",
  "0006_one_team_server_per_user.sql",
  "0007_team_host_machine_tokens.sql",
  "0008_remove_team_tunnel_vnc.sql",
  "0012_remote_control_plane.sql",
  "0013_remote_session_lifecycle.sql",
  "0014_mobile_auth_sessions.sql",
  "0015_email_challenge_delivery_state.sql",
  "0017_mobile_session_security.sql",
  "0018_remote_device_sessions.sql",
  "0033_mobile_session_connect_link.sql",
  "0043_user_analytics_enabled.sql",
  "0047_company_sign_in.sql",
] as const;

const migrationLedgerRowSchema = Schema.Struct({ migration_name: Schema.String, sha256: Schema.String });
type MigrationLedgerRow = typeof migrationLedgerRowSchema.Type;
const decodeMigrationLedgerRow: AuthD1RowDecoder<MigrationLedgerRow> =
  Schema.decodeUnknownSync(migrationLedgerRowSchema);
const triggerRowSchema = Schema.Struct({ name: Schema.String, tbl_name: Schema.String, sql: Schema.String });
type TriggerRow = typeof triggerRowSchema.Type;
const decodeTriggerRow: AuthD1RowDecoder<TriggerRow> = Schema.decodeUnknownSync(triggerRowSchema);
const SELF_HOSTED_SCHEMA_ERROR_CODES = [
  "schema_missing",
  "migration_mismatch",
  "schema_incomplete",
  "schema_unsupported",
] as const;

export class SelfHostedSchemaError extends Schema.TaggedError<SelfHostedSchemaError>()("SelfHostedSchemaError", {
  code: Schema.Literals(SELF_HOSTED_SCHEMA_ERROR_CODES),
}) {
  constructor(code: (typeof SELF_HOSTED_SCHEMA_ERROR_CODES)[number]) {
    super({ code });
  }
}

export interface SelfHostedAuthMigration {
  name: (typeof SELF_HOSTED_AUTH_MIGRATION_FILES)[number];
  sha256: string;
  sql: string;
}

export function readSelfHostedAuthMigrations(): readonly SelfHostedAuthMigration[] {
  try {
    return SELF_HOSTED_AUTH_MIGRATION_FILES.map((name) => {
      const contents = readFileSync(resolve(MIGRATION_DIRECTORY, name), "utf8");
      return {
        name,
        sha256: createHash("sha256").update(contents).digest("hex"),
        sql: contents,
      };
    });
  } catch {
    throw new SelfHostedSchemaError("schema_missing");
  }
}

/** Validates the exact supported schema and logout trigger without applying any migration. */
export const validateSelfHostedAuthSchema = Effect.fn("SelfHostedSchema.validate")(function* (
  database: AuthD1Database,
): Effect.fn.Return<void, SelfHostedSchemaError> {
  const migrations = yield* Effect.try({
    try: readSelfHostedAuthMigrations,
    catch: () => new SelfHostedSchemaError("schema_missing"),
  });
  const ledger = yield* Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT migration_name, sha256 FROM ${SELF_HOSTED_MIGRATION_TABLE} ORDER BY migration_name`)
        .all(decodeMigrationLedgerRow),
    catch: () => new SelfHostedSchemaError("schema_missing"),
  });
  const actual = new Map(ledger.results.map((row) => [row.migration_name, row.sha256]));
  if (actual.size !== migrations.length) return yield* new SelfHostedSchemaError("schema_unsupported");
  for (const migration of migrations) {
    if (actual.get(migration.name) !== migration.sha256) {
      return yield* new SelfHostedSchemaError("migration_mismatch");
    }
  }

  yield* validateRequiredColumns(database);
  const actualTriggers = yield* Effect.tryPromise({
    try: () =>
      database.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all(decodeTriggerRow),
    catch: () => new SelfHostedSchemaError("schema_incomplete"),
  });
  const trigger = actualTriggers.results[0];
  const source = migrations.find((migration) => migration.name === "0018_remote_device_sessions.sql");
  const expectedSql = source ? extractLogoutTriggerSql(source.sql) : null;
  if (
    actualTriggers.results.length !== 1 ||
    !trigger ||
    trigger.name !== "auth_session_revokes_remote_sessions" ||
    trigger.tbl_name !== "auth_sessions" ||
    expectedSql === null ||
    canonicalSql(trigger.sql) !== canonicalSql(expectedSql)
  ) {
    return yield* new SelfHostedSchemaError("schema_incomplete");
  }
});

function extractLogoutTriggerSql(migration: string): string | null {
  const match = /\bCREATE\s+TRIGGER\s+auth_session_revokes_remote_sessions\b[\s\S]*?\bEND\s*;/iu.exec(migration);
  return match?.[0] ?? null;
}

/** Compares SQL tokens while ignoring whitespace and comments, but preserves quoted values. */
function canonicalSql(sql: string): string {
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd < 0) return "";
      index = commentEnd + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const endCharacter = character === "[" ? "]" : character;
      let quoted = character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        const next = sql[index] ?? "";
        quoted += next;
        index += 1;
        if (next === endCharacter) {
          if (sql[index] === endCharacter && endCharacter !== "]") {
            quoted += endCharacter;
            index += 1;
          } else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) return "";
      tokens.push(quoted);
      continue;
    }
    if (/[a-z0-9_$]/iu.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[a-z0-9_$]/iu.test(sql[index] ?? "")) index += 1;
      tokens.push(sql.slice(start, index).toLowerCase());
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  if (tokens[tokens.length - 1] === ";") tokens.pop();
  return tokens.join(" ");
}

/** Creates and migrates a new, nonexistent SQLite file under the ignored local build directory. */
export async function initializeNewSelfHostedAuthDatabase(pathInput: string): Promise<void> {
  if (!pathInput || pathInput === ":memory:" || pathInput.includes("\0")) {
    throw new SelfHostedSchemaError("schema_unsupported");
  }
  const requestedPath = isAbsolute(pathInput) ? resolve(pathInput) : resolve(LOCAL_DATABASE_DIRECTORY, pathInput);
  const root = resolve(LOCAL_DATABASE_DIRECTORY);
  const pathRelativeToRoot = relative(root, requestedPath);
  if (!pathRelativeToRoot || pathRelativeToRoot === ".." || pathRelativeToRoot.startsWith(`..${sep}`)) {
    throw new SelfHostedSchemaError("schema_unsupported");
  }
  const parent = dirname(requestedPath);
  mkdirSync(parent, { recursive: true });
  const actualParent = realpathSync(parent);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const parentRelativeToRoot = relative(realRoot, actualParent);
  if (parentRelativeToRoot === ".." || parentRelativeToRoot.startsWith(`..${sep}`)) {
    throw new SelfHostedSchemaError("schema_unsupported");
  }

  let descriptor: number;
  try {
    descriptor = openSync(requestedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    throw new SelfHostedSchemaError("schema_unsupported");
  }
  closeSync(descriptor);

  let database: DatabaseSync | null = null;
  let createdByThisCall = true;
  try {
    database = new DatabaseSync(requestedPath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    database.exec(
      `CREATE TABLE ${SELF_HOSTED_MIGRATION_TABLE} (
         migration_name TEXT PRIMARY KEY,
         sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
         applied_at INTEGER NOT NULL
       )`,
    );
    for (const migration of readSelfHostedAuthMigrations()) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database
          .prepare(`INSERT INTO ${SELF_HOSTED_MIGRATION_TABLE}(migration_name, sha256, applied_at) VALUES (?, ?, ?)`)
          .run(migration.name, migration.sha256, Date.now());
        database.exec("COMMIT");
      } catch (cause) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Keep the migration failure as the cause and remove only the newly created file below.
        }
        throw cause;
      }
    }
    database.close();
    database = null;

    const adapter = new SqliteD1Database(
      new DatabaseSync(requestedPath, {
        allowExtension: false,
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      }),
    );
    try {
      await Effect.runPromise(validateSelfHostedAuthSchema(adapter));
    } finally {
      adapter.close();
    }
    createdByThisCall = false;
  } catch {
    try {
      database?.close();
    } catch {
      // Continue to remove the file created exclusively by this call.
    }
    if (createdByThisCall) unlinkSync(requestedPath);
    throw new SelfHostedSchemaError("schema_incomplete");
  }
}

const validateRequiredColumns = Effect.fn("SelfHostedSchema.validateRequiredColumns")(function* (
  database: AuthD1Database,
): Effect.fn.Return<void, SelfHostedSchemaError> {
  const statements = [
    "SELECT id, email, name, avatar_url, analytics_enabled, analytics_answered_at FROM users LIMIT 0",
    "SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, revoked_at FROM auth_sessions LIMIT 0",
    `SELECT id_hash, email, code_hash, source_ip_hash, created_at, expires_at, failed_attempts,
        max_attempts, consumed_at, delivery_state FROM email_login_challenges LIMIT 0`,
    "SELECT key_hash, window_start, attempts FROM auth_rate_limits LIMIT 0",
    `SELECT session_id, user_id, device_id, device_name, platform, created_at, connect_link_host_id
       FROM mobile_auth_sessions LIMIT 0`,
    "SELECT session_id, user_id, host_id, ended_at, auth_session_hash FROM remote_sessions LIMIT 0",
    "SELECT event_id, payload, created_at, attempts, next_attempt_at FROM remote_auth_events LIMIT 0",
    "SELECT host_id, enabled FROM company_sign_in_connections LIMIT 0",
    "SELECT domain, host_id FROM company_sign_in_domains LIMIT 0",
  ] as const;
  for (const query of statements) {
    yield* Effect.tryPromise({
      try: () => database.prepare(query).all((row) => row),
      catch: () => new SelfHostedSchemaError("schema_incomplete"),
    });
  }
});
