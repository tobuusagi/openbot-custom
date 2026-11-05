import { Effect, Schema } from "effect";
import {
  type AuthD1Database,
  type AuthD1PreparedStatement,
  type AuthD1RowDecoder,
  decodeAuthD1RawRow,
} from "./d1-auth-repository";

const TOKEN_HASH_SQL =
  "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL RETURNING token_hash";
const revokedSessionSchema = Schema.Struct({ token_hash: Schema.String });
const decodeRevokedSession = Schema.decodeUnknownSync(revokedSessionSchema);

/** The one database operation used by account-session logout on Worker and local SQLite. */
export interface AccountSessionLogoutStatement {
  bind(...values: unknown[]): AccountSessionLogoutStatement;
  first<A>(decode: AuthD1RowDecoder<A>): Promise<A | null>;
}

export interface AccountSessionLogoutDatabase {
  prepare(query: string): AccountSessionLogoutStatement;
}

export function accountSessionLogoutDatabaseFromWorker(
  database: Pick<D1Database, "prepare">,
): AccountSessionLogoutDatabase {
  return {
    prepare: (query) => new WorkerLogoutStatement(database.prepare(query)),
  };
}

/** Adapt the auth repository's decoder-based port without widening it to the full D1 surface. */
export function accountSessionLogoutDatabaseFromAuthD1(
  database: Pick<AuthD1Database, "prepare">,
): AccountSessionLogoutDatabase {
  return {
    prepare: (query) => new AuthD1LogoutStatement(database.prepare(query)),
  };
}

export interface AccountSessionLogoutOptions<E, R> {
  database: AccountSessionLogoutDatabase;
  userId: string;
  authSessionHash: string;
  now: number;
  sessionAlreadyEnded: () => E;
  databaseFailure: (cause: unknown) => E;
  flushAuthEvents: () => Effect.Effect<void, E, R>;
}

/**
 * Revokes one desktop account session. The migration trigger ends its remote sessions and queues
 * their disconnect outbox rows in the same SQLite/D1 statement transaction.
 */
export const endAccountSession = Effect.fn("AccountSessionLogout.end")(function* <E, R>(
  options: AccountSessionLogoutOptions<E, R>,
): Effect.fn.Return<void, E, R> {
  const revoked = yield* Effect.tryPromise({
    try: async () => {
      const row = await options.database
        .prepare(TOKEN_HASH_SQL)
        .bind(options.now, options.authSessionHash, options.userId)
        .first(decodeRevokedSession);
      return row;
    },
    catch: options.databaseFailure,
  });
  if (!revoked) return yield* Effect.fail(options.sessionAlreadyEnded());
  yield* options.flushAuthEvents();
});

class WorkerLogoutStatement implements AccountSessionLogoutStatement {
  readonly #statement: D1PreparedStatement;

  constructor(statement: D1PreparedStatement) {
    this.#statement = statement;
  }

  bind(...values: unknown[]): AccountSessionLogoutStatement {
    return new WorkerLogoutStatement(this.#statement.bind(...values));
  }

  async first<A>(decode: AuthD1RowDecoder<A>): Promise<A | null> {
    const row = await this.#statement.first();
    return row === null ? null : decode(decodeAuthD1RawRow(row));
  }
}

class AuthD1LogoutStatement implements AccountSessionLogoutStatement {
  readonly #statement: AuthD1PreparedStatement;

  constructor(statement: AuthD1PreparedStatement) {
    this.#statement = statement;
  }

  bind(...values: unknown[]): AccountSessionLogoutStatement {
    return new AuthD1LogoutStatement(this.#statement.bind(...values));
  }

  first<A>(decode: AuthD1RowDecoder<A>): Promise<A | null> {
    return this.#statement.first(decode);
  }
}
