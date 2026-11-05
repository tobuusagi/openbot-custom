// Drives the production OpenBotDatabase recovery API against an owned temporary openbot.db fixture.
// Run: `node --import tsx scripts/011-host-message-recovery-e2e.ts` (Node 24, real node:sqlite).
// Writes .openbot-build/011-host-message-recovery-e2e/report.json.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { HostChatRecoveryScope, HostChatRecoveryTarget } from "../src/backend/openbot-database";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-011-host-recovery-"));
const statePath = join(root, "state");
const database = new OpenBotDatabase(statePath);
const scope: HostChatRecoveryScope = {
  hostId: "fixture-host",
  userId: "fixture-user",
  deviceId: "fixture-device",
  grantId: "fixture-grant",
  capability: "chat",
  hostEpoch: 3,
  authEpoch: 5,
  grantEpoch: 7,
};
const target: HostChatRecoveryTarget = { agentId: "fixture-agent", threadId: "fixture-thread" };
const authorize = (authorizedScope: HostChatRecoveryScope, authorizedTarget: HostChatRecoveryTarget) =>
  authorizedScope.userId === "fixture-user" &&
  authorizedScope.grantId === "fixture-grant" &&
  authorizedTarget.agentId === "fixture-agent" &&
  authorizedTarget.threadId === "fixture-thread";
const report: { passed: boolean; steps: Array<{ name: string; passed: boolean }> } = { passed: false, steps: [] };

function step(name: string, run: () => void): void {
  run();
  report.steps.push({ name, passed: true });
}

try {
  await runCauseEffect(database.initialize());
  const request = { scope, target, requestId: "00112233445566778899aabbccddeeff", content: "fixture: hello" };
  step("authorization runs before content acceptance", () => {
    assert.throws(() => database.recordDurableChatRequest({ ...request, content: "x".repeat(786_433) }, () => false), {
      code: "UNAUTHORIZED",
    });
    assert.equal(
      database.connection.prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_messages").get()?.count,
      0,
    );
  });

  const receipt = database.recordDurableChatRequest(request, authorize);
  step("commit returns a durable receipt and event", () => {
    assert.equal(receipt.eventSequence, 1);
    assert.equal(
      database.connection.prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_messages").get()?.count,
      1,
    );
    assert.equal(
      database.connection.prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_events").get()?.count,
      1,
    );
  });
  step("same scoped request returns its original receipt and conflict fails", () => {
    assert.deepEqual(database.recordDurableChatRequest(request, authorize), receipt);
    assert.throws(() => database.recordDurableChatRequest({ ...request, content: "fixture: changed" }, authorize), {
      code: "REQUEST_ID_CONFLICT",
    });
    assert.throws(
      () =>
        database.recordDurableChatRequest(
          { ...request, target: { ...target, threadId: "fixture-other-thread" } },
          () => true,
        ),
      { code: "REQUEST_ID_CONFLICT" },
    );
    assert.equal(
      database.connection.prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_events").get()?.count,
      1,
    );
  });

  const otherGrant = { ...scope, grantId: "fixture-other-grant" };
  const otherReceipt = database.recordDurableChatRequest({ ...request, scope: otherGrant }, () => true);
  step("other grant has an isolated event sequence", () => {
    assert.equal(otherReceipt.eventSequence, 1);
    const result = database.readDurableChatEvents(otherGrant, undefined, () => true);
    assert.equal(result.status, "events");
    if (result.status === "events")
      assert.deepEqual(
        result.events.map((event) => event.content),
        [request.content],
      );
  });
  const pagedScope = { ...scope, grantId: "fixture-page-grant" };
  for (let index = 0; index < 101; index += 1) {
    database.recordDurableChatRequest(
      { scope: pagedScope, target, requestId: `page-${index}`, content: `fixture: page ${index}` },
      () => true,
    );
  }
  step("event reads page at the last returned cursor", () => {
    const firstPage = database.readDurableChatEvents(pagedScope, undefined, () => true);
    assert.equal(firstPage.status, "events");
    if (firstPage.status !== "events") throw new Error("Expected the first page of authorized events.");
    assert.equal(firstPage.events.length, 100);
    assert.equal(firstPage.cursor.sequence, 100);
    assert.equal(firstPage.hasMore, true);
    const finalPage = database.readDurableChatEvents(pagedScope, firstPage.cursor, () => true);
    assert.equal(finalPage.status, "events");
    if (finalPage.status !== "events") throw new Error("Expected the final page of authorized events.");
    assert.equal(finalPage.events.length, 1);
    assert.equal(finalPage.cursor.sequence, 101);
    assert.equal(finalPage.hasMore, false);
  });
  const bytePagedScope = { ...scope, grantId: "fixture-byte-page-grant" };
  const largeContent = `fixture: ${"x".repeat(600_000)}`;
  for (const requestId of ["large-1", "large-2"]) {
    database.recordDurableChatRequest({ scope: bytePagedScope, target, requestId, content: largeContent }, () => true);
  }
  step("event reads stop at the encoded byte budget", () => {
    const firstPage = database.readDurableChatEvents(bytePagedScope, undefined, () => true);
    assert.equal(firstPage.status, "events");
    if (firstPage.status !== "events") throw new Error("Expected the first byte-bounded page.");
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.cursor.sequence, 1);
    assert.equal(firstPage.hasMore, true);
  });
  step("epoch changes require a new snapshot", () => {
    const result = database.readDurableChatEvents(
      { ...scope, authEpoch: scope.authEpoch + 1 },
      {
        scopeKey: receipt.receiptId.slice(0, 64),
        sequence: receipt.eventSequence,
      },
      () => true,
    );
    assert.deepEqual(result, { status: "snapshot-required", reason: "scope-changed" });
  });

  database.connection.exec(`CREATE TEMP TRIGGER fail_host_chat_event BEFORE INSERT ON host_chat_recovery_events
    WHEN new.request_id = 'rollback-fixture' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  step("event failure rolls back message and sequence", () => {
    assert.throws(() => database.recordDurableChatRequest({ ...request, requestId: "rollback-fixture" }, authorize));
    assert.equal(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_messages WHERE request_id = 'rollback-fixture'")
        .get()?.count,
      0,
    );
    assert.equal(
      database.connection
        .prepare("SELECT last_sequence AS sequence FROM host_chat_recovery_scopes WHERE scope_key = ?")
        .get(receipt.receiptId.slice(0, 64))?.sequence,
      1,
    );
  });
  database.connection.exec("DROP TRIGGER fail_host_chat_event");

  const retry = database.recordDurableChatRequest({ ...request, requestId: "rollback-fixture" }, authorize);
  step("retry after rollback commits at the next sequence", () => {
    assert.equal(retry.eventSequence, 2);
    assert.deepEqual(database.connection.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.connection.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  });
  database.close();
  const reopened = new OpenBotDatabase(statePath);
  await runCauseEffect(reopened.initialize());
  step("restart retry returns the persisted receipt without adding an event", () => {
    assert.deepEqual(reopened.recordDurableChatRequest(request, authorize), receipt);
    assert.equal(
      reopened.connection
        .prepare("SELECT COUNT(*) AS count FROM host_chat_recovery_events WHERE scope_key = ?")
        .get(receipt.receiptId.slice(0, 64))?.count,
      2,
    );
    assert.equal(reopened.readDurableChatEvents(scope, undefined, () => true).status, "events");
  });
  step("current target revocation returns snapshot-required without event content", () => {
    assert.deepEqual(
      reopened.readDurableChatEvents(
        scope,
        undefined,
        (_authorizedScope, authorizedTarget) => authorizedTarget === undefined,
      ),
      { status: "snapshot-required", reason: "authorization-changed" },
    );
  });
  step("an event gap requires a snapshot", () => {
    reopened.connection
      .prepare("DELETE FROM host_chat_recovery_events WHERE scope_key = ? AND sequence = 1")
      .run(receipt.receiptId.slice(0, 64));
    assert.deepEqual(
      reopened.readDurableChatEvents(scope, undefined, () => true),
      {
        status: "snapshot-required",
        reason: "event-gap",
      },
    );
  });
  reopened.close();
  report.passed = true;
} finally {
  database.close();
  const output = join(resolve(import.meta.dirname, ".."), ".openbot-build", "011-host-message-recovery-e2e");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

if (!report.passed) process.exitCode = 1;
