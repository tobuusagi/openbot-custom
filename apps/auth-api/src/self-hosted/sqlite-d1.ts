import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  type AuthD1Database,
  type AuthD1PreparedStatement,
  type AuthD1ReadResult,
  type AuthD1RowDecoder,
  type AuthD1WriteResult,
  decodeAuthD1RawRow,
} from "../server/d1-auth-repository";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Local account-runtime adapter. It owns one synchronous SQLite connection and the statements it
 * creates. It does not apply migrations or own backups. The account repository owns query meaning.
 *
 * Supported operations are one prepared SQL statement, positional D1 scalar/byte bindings,
 * `first()` for SELECT or DML RETURNING, `all()` for SELECT, and `run()`/`batch()` for
 * INSERT/UPDATE/DELETE without RETURNING. Reads return rows without fabricated D1 scan metrics;
 * writes return SQLite's direct change count. Batch statements run in order in one SQLite
 * transaction. DDL, PRAGMA, CTEs, raw rows, exec, sessions, dump, and other result shapes are out of
 * scope and fail closed.
 */
export class SqliteD1Database implements AuthD1Database {
  readonly #connection: DatabaseSync;
  readonly #owner = Symbol("SqliteD1Database");
  #closed = false;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  prepare(query: string): AuthD1PreparedStatement {
    this.#assertOpen();
    const statement = this.#prepare(query);
    assertSingleStatement(query, statement.sourceSQL);
    return new SqliteD1PreparedStatement(this.#connection, this.#owner, query, []);
  }

  async batch(statements: AuthD1PreparedStatement[]): Promise<AuthD1WriteResult[]> {
    this.#assertOpen();
    if (statements.length === 0) return [];
    const prepared = statements.map((statement) => {
      if (!(statement instanceof SqliteD1PreparedStatement)) {
        throw new SqliteD1UnsupportedOperationError("batch statements must come from this SQLite adapter.");
      }
      statement.assertOwner(this.#owner);
      return statement;
    });

    this.#connection.exec("BEGIN IMMEDIATE");
    try {
      const results = prepared.map((statement) => statement.runInBatch(this.#owner));
      this.#connection.exec("COMMIT");
      return results;
    } catch (cause) {
      try {
        this.#connection.exec("ROLLBACK");
      } catch {
        // Preserve the statement or commit failure. A closed connection is already unusable.
      }
      throw cause;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
  }

  #prepare(query: string): StatementSync {
    const statement = this.#connection.prepare(query);
    assertSingleStatement(query, statement.sourceSQL);
    return statement;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SqliteD1UnsupportedOperationError("The local SQLite database is closed.");
    }
  }
}

class SqliteD1PreparedStatement implements AuthD1PreparedStatement {
  readonly #connection: DatabaseSync;
  readonly #owner: symbol;
  readonly #query: string;
  readonly #values: SQLInputValue[];

  constructor(connection: DatabaseSync, owner: symbol, query: string, values: SQLInputValue[]) {
    this.#connection = connection;
    this.#owner = owner;
    this.#query = query;
    this.#values = values;
  }

  bind(...values: unknown[]): AuthD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.#connection, this.#owner, this.#query, values.map(toSqliteInput));
  }

  async first<A>(decode: AuthD1RowDecoder<A>): Promise<A | null> {
    const statement = this.#connection.prepare(this.#query);
    assertSingleStatement(this.#query, statement.sourceSQL);
    assertRowsReturned(this.#query, statement);
    const row = statement.get(...this.#values);
    return row === undefined ? null : decode(decodeAuthD1RawRow(row));
  }

  async all<A>(decode: AuthD1RowDecoder<A>): Promise<AuthD1ReadResult<A>> {
    const statement = this.#connection.prepare(this.#query);
    assertSingleStatement(this.#query, statement.sourceSQL);
    if (leadingKeyword(this.#query) !== "SELECT") {
      throw new SqliteD1UnsupportedOperationError("all() supports SELECT statements only.");
    }
    assertRowsReturned(this.#query, statement);
    const rows = statement.all(...this.#values);
    return { results: rows.map((row) => decode(decodeAuthD1RawRow(row))) };
  }

  async run(): Promise<AuthD1WriteResult> {
    return this.#runMutation();
  }

  assertOwner(owner: symbol): void {
    if (owner !== this.#owner) {
      throw new SqliteD1UnsupportedOperationError("batch statements must come from this SQLite adapter.");
    }
  }

  runInBatch(owner: symbol): AuthD1WriteResult {
    this.assertOwner(owner);
    return this.#runMutation();
  }

  #runMutation(): AuthD1WriteResult {
    const statement = this.#connection.prepare(this.#query);
    assertSingleStatement(this.#query, statement.sourceSQL);
    assertMutation(this.#query, statement);
    const result = statement.run(...this.#values);
    return {
      meta: { changes: safeSqliteCount(result.changes) },
    };
  }
}

export class SqliteD1UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteD1UnsupportedOperationError";
  }
}

/** Open a local database file. This never creates or applies an account schema migration. */
export function openSqliteD1Database(path: string): SqliteD1Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const connection = new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  return new SqliteD1Database(connection);
}

function toSqliteInput(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new SqliteD1UnsupportedOperationError("This SQLite adapter supports only D1 scalar and byte-array bindings.");
}

function assertSingleStatement(query: string, sourceSQL: string): void {
  if (!query.startsWith(sourceSQL)) {
    throw new SqliteD1UnsupportedOperationError("SQLite did not prepare the complete SQL statement.");
  }
  if (hasSqlToken(query.slice(sourceSQL.length))) {
    throw new SqliteD1UnsupportedOperationError("Multiple SQL statements are not supported by the local adapter.");
  }
}

function hasSqlToken(remainder: string): boolean {
  let index = 0;
  while (index < remainder.length) {
    if (/\s/u.test(remainder[index] ?? "")) {
      index += 1;
      continue;
    }
    if (remainder.startsWith("--", index)) {
      const newline = remainder.indexOf("\n", index + 2);
      index = newline === -1 ? remainder.length : newline + 1;
      continue;
    }
    if (remainder.startsWith("/*", index)) {
      const end = remainder.indexOf("*/", index + 2);
      if (end === -1) return true;
      index = end + 2;
      continue;
    }
    return true;
  }
  return false;
}

function assertRowsReturned(query: string, statement: StatementSync): void {
  const keyword = leadingKeyword(query);
  if (statement.columns().length === 0 || !["SELECT", "INSERT", "UPDATE", "DELETE"].includes(keyword)) {
    throw new SqliteD1UnsupportedOperationError("first() and all() require a read query or DML RETURNING clause.");
  }
}

function assertMutation(query: string, statement: StatementSync): void {
  if (!["INSERT", "UPDATE", "DELETE"].includes(leadingKeyword(query)) || statement.columns().length !== 0) {
    throw new SqliteD1UnsupportedOperationError(
      "run() and batch() support INSERT, UPDATE, or DELETE without RETURNING.",
    );
  }
}

function leadingKeyword(query: string): string {
  const withoutLeadingComments = query.replace(/^(?:(?:\s+)|(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))*/u, "");
  return /^([a-z]+)/iu.exec(withoutLeadingComments)?.[1]?.toUpperCase() ?? "";
}

function safeSqliteCount(value: number | bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new SqliteD1UnsupportedOperationError(
      "SQLite returned a count outside the D1-compatible safe integer range.",
    );
  }
  return count;
}
