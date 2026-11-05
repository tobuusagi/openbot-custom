import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChatScope = {
  hostId: string;
  userId: string;
  deviceId: string;
  grantId: string;
  capability: "chat";
  hostEpoch: number;
  authEpoch: number;
  grantEpoch: number;
};

export type ChatRequest = { requestId: string; content: string };

export type DurableReceipt = {
  receiptId: string;
  requestId: string;
  requestHash: string;
  messageId: string;
  eventSequence: number;
  committedAt: number;
};

export type FixtureEvent = {
  sequence: number;
  kind: "chat-message";
  messageId: string;
  content: string;
};

export type Cursor = ChatScope & { sequence: number };

export type EventRead =
  | { status: "events"; events: FixtureEvent[]; cursor: Cursor }
  | { status: "snapshot-required"; reason: "scope-changed" | "cursor-ahead" | "event-gap" };

export type CrashPoint = "before-commit" | "after-commit-before-return";

export class RecoveryStoreError extends Error {
  readonly code: "UNAUTHORIZED" | "REQUEST_ID_CONFLICT" | "CAPACITY_EXCEEDED" | "INVALID_INPUT";

  constructor(code: "UNAUTHORIZED" | "REQUEST_ID_CONFLICT" | "CAPACITY_EXCEEDED" | "INVALID_INPUT", message: string) {
    super(message);
    this.code = code;
    this.name = "RecoveryStoreError";
  }
}

export class SimulatedCrashError extends Error {
  readonly point: CrashPoint;

  constructor(point: CrashPoint) {
    super(`Simulated crash at ${point}`);
    this.point = point;
    this.name = "SimulatedCrashError";
  }
}

const OWNED_FIXTURE = Symbol("owned-fixture");
const FIXTURE_APPLICATION_ID = 0x4f425231;
const FIXTURE_SCHEMA_VERSION = 1;
const SCOPE_COLUMNS = ["host_id", "user_id", "device_id", "grant_id", "capability", "host_epoch", "auth_epoch", "grant_epoch"] as const;
const SCOPE_KEYS = ["hostId", "userId", "deviceId", "grantId", "capability", "hostEpoch", "authEpoch", "grantEpoch"] as const;
const DEFAULT_MAX_RECEIPTS = 5_000;
const DEFAULT_MAX_EVENTS = 10_000;
const PAGE_SIZE = 100;
const TABLE_COLUMNS = {
  fixture_messages: ["message_id", ...SCOPE_COLUMNS, "content", "created_at"],
  fixture_events: [...SCOPE_COLUMNS, "sequence", "kind", "message_id", "content"],
  chat_receipts: ["receipt_id", ...SCOPE_COLUMNS, "request_id", "request_hash", "message_id", "event_sequence", "committed_at"],
} as const;

type Authorize = (scope: ChatScope) => boolean;
type Options = { maxReceipts?: number; maxEvents?: number };
type Limits = { maxReceipts: number; maxEvents: number };
type SqlRow = Record<string, unknown>;

/** Creates and owns a new SQLite file under a unique OS temporary directory. */
export class RecoveryStore {
  readonly #root: string;
  readonly #databasePath: string;
  readonly #authorize: Authorize;
  readonly #limits: Limits;
  #db: DatabaseSync | null = null;
  readonly #allowCreate: boolean;

  static createTemporary(authorize: Authorize, options: Options = {}): RecoveryStore {
    const temporaryRoot = realpathSync(tmpdir());
    const root = mkdtempSync(join(temporaryRoot, "openbot-message-recovery-"));
    try {
      return new RecoveryStore(root, authorize, options, OWNED_FIXTURE, true);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  private constructor(root: string, authorize: Authorize, options: Options, ownership: symbol, allowCreate: boolean) {
    if (ownership !== OWNED_FIXTURE) throw new RecoveryStoreError("INVALID_INPUT", "Only an owned temporary fixture can open a database.");
    this.#root = root;
    this.#allowCreate = allowCreate;
    this.#databasePath = join(root, "fixture.sqlite");
    this.#authorize = authorize;
    this.#limits = {
      maxReceipts: options.maxReceipts ?? DEFAULT_MAX_RECEIPTS,
      maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
    };
    if (!Number.isSafeInteger(this.#limits.maxReceipts) || this.#limits.maxReceipts < 1 || !Number.isSafeInteger(this.#limits.maxEvents) || this.#limits.maxEvents < 1) {
      throw new RecoveryStoreError("INVALID_INPUT", "Storage bounds must be positive safe integers.");
    }
    this.#openDatabase();
  }

  appendChat(scope: ChatScope, request: ChatRequest, crashAt?: CrashPoint): DurableReceipt {
    this.#assertAuthorized(scope);
    this.#validateRequest(request);
    const requestHash = requestHashFor(scope, request.content);
    const db = this.#requireDatabase();

    const existing = this.#findReceipt(db, scope, request.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new RecoveryStoreError("REQUEST_ID_CONFLICT", "Request ID was already committed with a different request hash.");
      }
      return existing;
    }

    let committed = false;
    db.exec("BEGIN IMMEDIATE;");
    try {
      const concurrent = this.#findReceipt(db, scope, request.requestId);
      if (concurrent) {
        if (concurrent.requestHash !== requestHash) {
          throw new RecoveryStoreError("REQUEST_ID_CONFLICT", "Request ID was already committed with a different request hash.");
        }
        db.exec("COMMIT;");
        committed = true;
        return concurrent;
      }

      if (readCount(db.prepare("SELECT COUNT(*) AS count FROM chat_receipts").get()) >= this.#limits.maxReceipts ||
        readCount(db.prepare("SELECT COUNT(*) AS count FROM fixture_events").get()) >= this.#limits.maxEvents) {
        throw new RecoveryStoreError("CAPACITY_EXCEEDED", "Fixture storage reached its configured bound.");
      }

      const messageId = randomUUID();
      const receiptId = randomUUID();
      const createdAt = Date.now();
      const nextSequence = this.#nextSequence(db, scope);
      this.#insertScoped(db, "fixture_messages", scope, "message_id, content, created_at", [messageId, request.content, createdAt]);
      this.#insertScoped(db, "fixture_events", scope, "sequence, kind, message_id, content", [nextSequence, "chat-message", messageId, request.content]);
      this.#insertScoped(db, "chat_receipts", scope, "receipt_id, request_id, request_hash, message_id, event_sequence, committed_at", [receiptId, request.requestId, requestHash, messageId, nextSequence, createdAt]);

      const receipt: DurableReceipt = { receiptId, requestId: request.requestId, requestHash, messageId, eventSequence: nextSequence, committedAt: createdAt };
      if (crashAt === "before-commit") throw new SimulatedCrashError(crashAt);
      db.exec("COMMIT;");
      committed = true;
      if (crashAt === "after-commit-before-return") throw new SimulatedCrashError(crashAt);
      return receipt;
    } catch (error) {
      if (!committed) db.exec("ROLLBACK;");
      throw error;
    }
  }

  readEvents(scope: ChatScope, after?: Cursor): EventRead {
    this.#assertAuthorized(scope);
    if (after && !sameScope(scope, after)) return { status: "snapshot-required", reason: "scope-changed" };
    const sequence = after?.sequence ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) return { status: "snapshot-required", reason: "cursor-ahead" };

    const rows = this.#selectEvents(this.#requireDatabase(), scope);
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]?.sequence !== index + 1) return { status: "snapshot-required", reason: "event-gap" };
    }
    const lastSequence = rows.at(-1)?.sequence ?? 0;
    if (sequence > lastSequence) return { status: "snapshot-required", reason: "cursor-ahead" };

    const page = rows.filter((row) => row.sequence > sequence).slice(0, PAGE_SIZE);
    const nextSequence = page.at(-1)?.sequence ?? sequence;
    return { status: "events", events: page, cursor: { ...scope, sequence: nextSequence } };
  }

  /** Close this SQLite connection. Call reopen() to use the same owned fixture again. */
  close(): void {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }

  /** Reopen the same owned file and recheck its fixture identity and schema. */
  reopen(): RecoveryStore {
    if (this.#db) throw new RecoveryStoreError("INVALID_INPUT", "Close the fixture connection before reopening it.");
    return new RecoveryStore(this.#root, this.#authorize, this.#limits, OWNED_FIXTURE, false);
  }

  /** Deliberately corrupt one fixture event so the scenario can exercise gap handling. */
  deleteFixtureEventForScenario(scope: ChatScope, sequence: number): void {
    this.#assertAuthorized(scope);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RecoveryStoreError("INVALID_INPUT", "Fixture sequence is invalid.");
    const where = SCOPE_COLUMNS.map((column) => `${column} = ?`).join(" AND ");
    this.#requireDatabase().prepare(`DELETE FROM fixture_events WHERE ${where} AND sequence = ?`).run(...scopeValues(scope), sequence);
  }

  /** Replace only this owned file with a non-fixture DB for rejection scenarios. */
  replaceOwnedDatabaseWithNonFixtureForScenario(): void {
    this.close();
    rmSync(this.#databasePath, { force: true });
    const foreign = new DatabaseSync(this.#databasePath);
    try {
      foreign.exec("CREATE TABLE unrelated_data (value TEXT NOT NULL);");
    } finally {
      foreign.close();
    }
  }

  /** Close and remove only this fixture's own temporary directory. */
  dispose(): void {
    this.close();
    rmSync(this.#root, { recursive: true, force: true });
  }

  #openDatabase(): void {
    const temporaryRoot = realpathSync(tmpdir());
    const realRoot = realpathSync(this.#root);
    if (realRoot !== this.#root || dirname(realRoot) !== temporaryRoot || basename(this.#databasePath) !== "fixture.sqlite") {
      throw new RecoveryStoreError("INVALID_INPUT", "Fixture path is outside its owned temporary root.");
    }

    let fresh = false;
    try {
      const file = lstatSync(this.#databasePath);
      if (file.isSymbolicLink() || !file.isFile() || file.nlink !== 1) {
        throw new RecoveryStoreError("INVALID_INPUT", "Fixture database must be a regular, unlinked file.");
      }
    } catch (error) {
      if (isMissingPath(error) && this.#allowCreate) fresh = true;
      else if (isMissingPath(error)) throw new RecoveryStoreError("INVALID_INPUT", "Owned fixture database is missing; refusing to recreate it.");
      else throw error;
    }

    const db = new DatabaseSync(this.#databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (fresh) this.#createSchema(db);
      else this.#verifySchema(db);
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #createSchema(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`
        CREATE TABLE fixture_messages (
          message_id TEXT PRIMARY KEY,
          ${SCOPE_COLUMNS.map((column) => `${column} ${column.endsWith("_epoch") ? "INTEGER" : "TEXT"} NOT NULL`).join(",\n          ")},
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE fixture_events (
          ${SCOPE_COLUMNS.map((column) => `${column} ${column.endsWith("_epoch") ? "INTEGER" : "TEXT"} NOT NULL`).join(",\n          ")},
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind = 'chat-message'),
          message_id TEXT NOT NULL REFERENCES fixture_messages(message_id),
          content TEXT NOT NULL,
          PRIMARY KEY (${SCOPE_COLUMNS.join(", ")}, sequence)
        );
        CREATE TABLE chat_receipts (
          receipt_id TEXT PRIMARY KEY,
          ${SCOPE_COLUMNS.map((column) => `${column} ${column.endsWith("_epoch") ? "INTEGER" : "TEXT"} NOT NULL`).join(",\n          ")},
          request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          message_id TEXT NOT NULL UNIQUE REFERENCES fixture_messages(message_id),
          event_sequence INTEGER NOT NULL,
          committed_at INTEGER NOT NULL,
          UNIQUE (${SCOPE_COLUMNS.join(", ")}, request_id)
        );
        CREATE INDEX fixture_events_message_idx ON fixture_events(message_id);
      `);
      db.exec(`PRAGMA application_id = ${FIXTURE_APPLICATION_ID}; PRAGMA user_version = ${FIXTURE_SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    this.#verifySchema(db);
  }

  #verifySchema(db: DatabaseSync): void {
    if (readInteger(db.prepare("PRAGMA application_id").get(), "application_id") !== FIXTURE_APPLICATION_ID ||
      readInteger(db.prepare("PRAGMA user_version").get(), "user_version") !== FIXTURE_SCHEMA_VERSION) {
      throw new RecoveryStoreError("INVALID_INPUT", "Existing file is not a recognized recovery fixture database.");
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => readString(row, "name"));
    const expectedTables = Object.keys(TABLE_COLUMNS).sort();
    if (tables.length !== expectedTables.length || tables.some((name, index) => name !== expectedTables[index])) {
      throw new RecoveryStoreError("INVALID_INPUT", "Recovery fixture schema does not match this model.");
    }
    for (const [table, expectedColumns] of Object.entries(TABLE_COLUMNS)) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => readString(row, "name"));
      if (columns.length !== expectedColumns.length || columns.some((name, index) => name !== expectedColumns[index])) {
        throw new RecoveryStoreError("INVALID_INPUT", `Recovery fixture table ${table} has an unexpected shape.`);
      }
    }
  }

  #assertAuthorized(scope: ChatScope): void {
    validateScope(scope);
    if (scope.capability !== "chat" || !this.#authorize(scope)) {
      throw new RecoveryStoreError("UNAUTHORIZED", "Chat capability is not authorized for this scope.");
    }
  }

  #validateRequest(request: ChatRequest): void {
    if (!request || typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 128 ||
      typeof request.content !== "string" || request.content.length > 16_384) {
      throw new RecoveryStoreError("INVALID_INPUT", "Request fields are outside the fixture limits.");
    }
  }

  #findReceipt(db: DatabaseSync, scope: ChatScope, requestId: string): DurableReceipt | undefined {
    const where = SCOPE_COLUMNS.map((column) => `${column} = ?`).join(" AND ");
    const row = db.prepare(`SELECT receipt_id, request_id, request_hash, message_id, event_sequence, committed_at FROM chat_receipts WHERE ${where} AND request_id = ?`)
      .get(...scopeValues(scope), requestId);
    if (!row) return undefined;
    return {
      receiptId: readString(row, "receipt_id"),
      requestId: readString(row, "request_id"),
      requestHash: readString(row, "request_hash"),
      messageId: readString(row, "message_id"),
      eventSequence: readInteger(row, "event_sequence"),
      committedAt: readInteger(row, "committed_at"),
    };
  }

  #nextSequence(db: DatabaseSync, scope: ChatScope): number {
    const where = SCOPE_COLUMNS.map((column) => `${column} = ?`).join(" AND ");
    return readInteger(db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM fixture_events WHERE ${where}`).get(...scopeValues(scope)), "next");
  }

  #insertScoped(db: DatabaseSync, table: string, scope: ChatScope, tail: string, values: Array<string | number>): void {
    const columns = [...SCOPE_COLUMNS, ...tail.split(", ")];
    const placeholders = columns.map(() => "?").join(", ");
    db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(...scopeValues(scope), ...values);
  }

  #selectEvents(db: DatabaseSync, scope: ChatScope): FixtureEvent[] {
    const where = SCOPE_COLUMNS.map((column) => `${column} = ?`).join(" AND ");
    return db.prepare(`SELECT sequence, kind, message_id, content FROM fixture_events WHERE ${where} ORDER BY sequence`)
      .all(...scopeValues(scope)).map((row) => {
        const kind = readString(row, "kind");
        if (kind !== "chat-message") throw new RecoveryStoreError("INVALID_INPUT", "Fixture event kind is invalid.");
        return {
          sequence: readInteger(row, "sequence"),
          kind,
          messageId: readString(row, "message_id"),
          content: readString(row, "content"),
        };
      });
  }

  #requireDatabase(): DatabaseSync {
    if (!this.#db) throw new RecoveryStoreError("INVALID_INPUT", "Fixture database is closed.");
    return this.#db;
  }
}

function requestHashFor(scope: ChatScope, content: string): string {
  const canonicalFixture = JSON.stringify([...scopeValues(scope), content]);
  return createHash("sha256").update(canonicalFixture, "utf8").digest("hex");
}

function scopeValues(scope: ChatScope): Array<string | number> {
  return [scope.hostId, scope.userId, scope.deviceId, scope.grantId, scope.capability, scope.hostEpoch, scope.authEpoch, scope.grantEpoch];
}

function sameScope(left: ChatScope, right: ChatScope): boolean {
  return SCOPE_KEYS.every((key) => left[key] === right[key]);
}

function validateScope(scope: ChatScope): void {
  if (!scope || [scope.hostId, scope.userId, scope.deviceId, scope.grantId].some((value) => typeof value !== "string" || value.length < 1 || value.length > 128) ||
    scope.capability !== "chat" || [scope.hostEpoch, scope.authEpoch, scope.grantEpoch].some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RecoveryStoreError("INVALID_INPUT", "Scope fields are invalid.");
  }
}

function readString(row: SqlRow | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value !== "string") throw new RecoveryStoreError("INVALID_INPUT", `Fixture database column ${column} is invalid.`);
  return value;
}

function readInteger(row: SqlRow | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new RecoveryStoreError("INVALID_INPUT", `Fixture database column ${column} is invalid.`);
  return value;
}

function readCount(row: SqlRow | undefined): number {
  return readInteger(row, "count");
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
