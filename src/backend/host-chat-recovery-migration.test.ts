// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function databaseAt(version: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(database)).toThrow(`migration to version ${version + 1} failed`);
  database.exec("DROP TRIGGER stop_at_version");
  return database;
}

describe("Host chat recovery migration", () => {
  it("preserves existing rows and rolls back all v56 tables and marker after a late failure, then retries", () => {
    const database = databaseAt(55);
    database
      .prepare(
        `INSERT INTO orchestration_command_receipts(command_id, accepted_at, first_sequence, last_sequence, result_json)
       VALUES ('fixture-existing', '2026-11-05T00:00:00.000Z', 1, 1, '{}')`,
      )
      .run();
    database.exec(`CREATE TEMP TRIGGER fail_v56_marker BEFORE INSERT ON schema_migrations WHEN new.version = 56
      BEGIN SELECT RAISE(ABORT, 'fixture late failure'); END;`);

    expect(() => migrateOpenBotDatabase(database)).toThrow("migration to version 56 failed");
    expect(database.prepare("SELECT command_id FROM orchestration_command_receipts").all()).toEqual([
      { command_id: "fixture-existing" },
    ]);
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 56").all()).toEqual([]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'host_chat_recovery_%'").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

    database.exec("DROP TRIGGER fail_v56_marker");
    migrateOpenBotDatabase(database);
    expect(database.prepare("SELECT command_id FROM orchestration_command_receipts").all()).toEqual([
      { command_id: "fixture-existing" },
    ]);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 57 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("preserves v56 inbox rows and rolls back v57 ledger DDL and marker after late failure, then retries", () => {
    const database = databaseAt(56);
    database
      .prepare(
        "INSERT INTO host_chat_recovery_scopes(scope_key, scope_json, last_sequence) VALUES ('scope-fixture', '{}', 0)",
      )
      .run();
    database.exec(`CREATE TEMP TRIGGER fail_v57_marker BEFORE INSERT ON schema_migrations WHEN new.version = 57
      BEGIN SELECT RAISE(ABORT, 'fixture late failure'); END;`);

    expect(() => migrateOpenBotDatabase(database)).toThrow("migration to version 57 failed");
    expect(database.prepare("SELECT scope_key FROM host_chat_recovery_scopes").all()).toEqual([
      { scope_key: "scope-fixture" },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'host_chat_delivery_ledger'").all()).toEqual(
      [],
    );
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 57").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

    database.exec("DROP TRIGGER fail_v57_marker");
    migrateOpenBotDatabase(database);
    expect(database.prepare("SELECT scope_key FROM host_chat_recovery_scopes").all()).toEqual([
      { scope_key: "scope-fixture" },
    ]);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 57 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("rejects a missing migration marker and a newer database without changing either", () => {
    const missing = databaseAt(55);
    missing.prepare("DELETE FROM schema_migrations WHERE version = 54").run();
    expect(() => migrateOpenBotDatabase(missing)).toThrow("missing version 54");
    expect(missing.prepare("SELECT name FROM sqlite_master WHERE name = 'host_chat_recovery_scopes'").all()).toEqual(
      [],
    );

    const newer = databaseAt(56);
    newer.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (58, 'fixture')").run();
    expect(() => migrateOpenBotDatabase(newer)).toThrow("newer than this application supports (57)");
    expect(newer.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 58 });
    expect(newer.prepare("SELECT name FROM sqlite_master WHERE name = 'host_chat_recovery_scopes'").all()).toEqual([
      { name: "host_chat_recovery_scopes" },
    ]);
  });

  it("keeps new-install and upgrade schemas aligned", () => {
    const fresh = new DatabaseSync(":memory:");
    const upgraded = databaseAt(55);
    databases.push(fresh);
    migrateOpenBotDatabase(fresh);
    migrateOpenBotDatabase(upgraded);
    const shapes = (database: DatabaseSync) =>
      database
        .prepare(
          `SELECT type, name, sql FROM sqlite_master
           WHERE name LIKE 'host_chat_recovery_%' OR name = 'host_chat_delivery_ledger' ORDER BY type, name`,
        )
        .all();
    expect(shapes(fresh)).toEqual(shapes(upgraded));
    expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
