// Exercises the production Host inbox snapshot API against an owned temporary openbot.db.
// The snapshot contains Host-accepted inbox requests; it is not conversation or Provider history.
// Run: `node --import tsx scripts/011-host-chat-snapshot-e2e.ts`.
// Writes .openbot-build/011-host-chat-snapshot-e2e/report.json.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { HostChatRecoveryScope, HostChatRecoveryTarget } from "../src/backend/openbot-database";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-011-host-snapshot-"));
const statePath = join(root, "state");
const database = new OpenBotDatabase(statePath);
const concurrentWriter = new OpenBotDatabase(statePath);
const scope: HostChatRecoveryScope = {
  hostId: "fixture-host",
  userId: "fixture-user",
  deviceId: "fixture-device",
  grantId: "fixture-snapshot-grant",
  capability: "chat",
  hostEpoch: 2,
  authEpoch: 4,
  grantEpoch: 6,
};
const target: HostChatRecoveryTarget = { agentId: "fixture-agent", threadId: "fixture-thread" };
const authorize = (_scope: HostChatRecoveryScope, _target?: HostChatRecoveryTarget) => true;
const report: { passed: boolean; steps: Array<{ name: string; passed: boolean }> } = { passed: false, steps: [] };

function step(name: string, run: () => void): void {
  run();
  report.steps.push({ name, passed: true });
}

try {
  await runCauseEffect(database.initialize());
  await runCauseEffect(concurrentWriter.initialize());
  const first = database.recordDurableChatRequest(
    { scope, target, requestId: "snapshot-1", content: "fixture: inbox first" },
    () => true,
  );
  const second = database.recordDurableChatRequest(
    { scope, target, requestId: "snapshot-2", content: "fixture: inbox second" },
    () => true,
  );

  let readTransactionObserved = false;
  let wroteAfterSnapshotHead = false;
  let concurrentReceiptSequence = 0;
  const snapshot = database.readDurableChatSnapshot(scope, (authorizedScope, authorizedTarget) => {
    readTransactionObserved ||= database.connection.isTransaction;
    if (authorizedTarget && !wroteAfterSnapshotHead) {
      wroteAfterSnapshotHead = true;
      concurrentReceiptSequence = concurrentWriter.recordDurableChatRequest(
        { scope, target, requestId: "snapshot-concurrent", content: "fixture: concurrent after head" },
        () => true,
      ).eventSequence;
    }
    return (
      authorizedScope.grantId === scope.grantId &&
      (authorizedTarget === undefined || authorizedTarget.threadId === target.threadId)
    );
  });
  step("snapshot is complete and shares a read transaction with its cursor", () => {
    assert.equal(readTransactionObserved, true);
    assert.equal(snapshot.type, "host-chat-inbox-snapshot");
    assert.equal(snapshot.complete, true);
    assert.deepEqual(
      snapshot.acceptedRequests.map((request) => request.requestId),
      ["snapshot-1", "snapshot-2"],
    );
    assert.equal(snapshot.cursor.scopeKey, first.receiptId.slice(0, 64));
    assert.equal(snapshot.cursor.sequence, second.eventSequence);
    assert.equal(concurrentReceiptSequence, 3);
    assert.equal(database.connection.isTransaction, false);
  });

  step("revoked target authorization fails closed before returning snapshot data", () => {
    assert.throws(
      () =>
        database.readDurableChatSnapshot(scope, (_authorizedScope, authorizedTarget) => authorizedTarget === undefined),
      { code: "UNAUTHORIZED" },
    );
    assert.equal(database.connection.isTransaction, false);
  });

  database.connection
    .prepare("DELETE FROM host_chat_recovery_events WHERE scope_key = ? AND sequence = 1")
    .run(snapshot.cursor.scopeKey);
  step("gap requires a snapshot and the snapshot cursor recovers the stream", () => {
    assert.deepEqual(database.readDurableChatEvents(scope, undefined, authorize), {
      status: "snapshot-required",
      reason: "event-gap",
    });
    const recoverySnapshot = database.readDurableChatSnapshot(scope, authorize);
    assert.equal(recoverySnapshot.acceptedRequests.length, 3);
    assert.equal(recoverySnapshot.cursor.sequence, 3);
    database.recordDurableChatRequest(
      { scope, target, requestId: "snapshot-3", content: "fixture: after snapshot" },
      () => true,
    );
    const tail = database.readDurableChatEvents(scope, recoverySnapshot.cursor, authorize);
    assert.equal(tail.status, "events");
    if (tail.status !== "events") throw new Error("Expected events after the recovery snapshot cursor.");
    assert.deepEqual(
      tail.events.map((event) => event.requestId),
      ["snapshot-3"],
    );
  });

  const largeScope = { ...scope, grantId: "fixture-overflow-grant" };
  const largeContent = `fixture: ${"x".repeat(600_000)}`;
  for (const requestId of ["overflow-1", "overflow-2"]) {
    database.recordDurableChatRequest({ scope: largeScope, target, requestId, content: largeContent }, () => true);
  }
  step("oversized snapshots fail without a partial body or cursor advance", () => {
    assert.throws(() => database.readDurableChatSnapshot(largeScope, authorize), {
      code: "SNAPSHOT_CAPACITY_EXCEEDED",
    });
    assert.equal(database.connection.isTransaction, false);
    const events = database.readDurableChatEvents(largeScope, undefined, authorize);
    assert.equal(events.status, "events");
    if (events.status !== "events") throw new Error("Overflow must leave the event cursor readable.");
    assert.equal(events.cursor.sequence, 1);
    assert.equal(events.hasMore, true);
    const secondPage = database.readDurableChatEvents(largeScope, events.cursor, authorize);
    assert.equal(secondPage.status, "events");
    if (secondPage.status !== "events") throw new Error("Expected the remaining event after the bounded first page.");
    assert.equal(secondPage.cursor.sequence, 2);
    assert.equal(secondPage.hasMore, false);
  });

  const countScope = { ...scope, grantId: "fixture-count-overflow-grant" };
  for (let index = 0; index < 501; index += 1) {
    database.recordDurableChatRequest(
      { scope: countScope, target, requestId: `count-${index}`, content: "fixture: bounded count" },
      () => true,
    );
  }
  step("snapshots above the request count limit fail closed", () => {
    assert.throws(() => database.readDurableChatSnapshot(countScope, authorize), {
      code: "SNAPSHOT_CAPACITY_EXCEEDED",
    });
    assert.equal(database.connection.isTransaction, false);
  });

  report.passed = true;
} finally {
  database.close();
  concurrentWriter.close();
  const output = join(resolve(import.meta.dirname, ".."), ".openbot-build", "011-host-chat-snapshot-e2e");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

if (!report.passed) process.exitCode = 1;
