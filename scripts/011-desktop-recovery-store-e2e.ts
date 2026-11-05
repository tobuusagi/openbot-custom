import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatInboxSnapshot,
  DurableChatReceipt,
  MessageRecoveryScope,
  RecoveredChatEvent,
} from "@openbot/team-client/message-recovery";
import { isRecord } from "../src/backend/protocol";
import { clientRecoveryScopeKey, createClientRecoveryStore } from "../src/main/client-recovery-store";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function isRequest(value: unknown, requestId: string): boolean {
  return isRecord(value) && value.requestId === requestId;
}
function numberColumn(value: unknown, column: "count" | "sequence"): number {
  if (!isRecord(value) || typeof value[column] !== "number") {
    throw new Error(`SQLite column ${column} is invalid.`);
  }
  return value[column];
}
async function rejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  let failed = false;
  try {
    await operation();
  } catch {
    failed = true;
  }
  assert(failed, message);
}

const root = await mkdtemp(join(tmpdir(), "openbot-011-desktop-recovery-"));
const profile = join(root, "client-profile");
const scope: MessageRecoveryScope = {
  hostId: "host-a",
  userId: "user-a",
  deviceId: "device-a",
  grantId: "grant-a",
  capability: "chat",
  hostEpoch: 2,
  authEpoch: 3,
  grantEpoch: 4,
};
const scopeB = { ...scope, userId: "user-b" };
const target = { agentId: "agent-a", threadId: "thread-a" };
const event = (sequence: number): RecoveredChatEvent => ({
  sequence,
  messageId: `message-${sequence}`,
  requestId: `request-${sequence}`,
  target,
  content: `recovered ${sequence}`,
  occurredAt: "2026-11-05T00:00:00.000Z",
});
const hostScopeKey = clientRecoveryScopeKey(scope);
const snapshot = (sequence: number, scopeKey = hostScopeKey): ChatInboxSnapshot => ({
  type: "host-chat-inbox-snapshot",
  complete: true,
  acceptedRequests: Array.from({ length: sequence }, (_, i) => ({
    sequence: i + 1,
    messageId: `accepted-${i + 1}`,
    requestId: `accepted-request-${i + 1}`,
    target,
    content: `accepted inbox ${i + 1}`,
    acceptedAt: "2026-11-05T00:00:00.000Z",
  })),
  cursor: { scopeKey, sequence },
});
const report: string[] = [];

try {
  let store = await createClientRecoveryStore(profile);
  const signal = new AbortController().signal;
  const pending = { requestId: "request-outbox", target, content: "pending" };
  await store.enqueuePendingChat(scope, pending, signal);
  await store.enqueuePendingChat(scope, pending, signal);
  await rejects(
    () => store.enqueuePendingChat(scope, { ...pending, content: "conflict" }, signal),
    "conflicting pending id was accepted",
  );
  store.close();
  store = await createClientRecoveryStore(profile);
  assert((await store.listPendingChats(scope, signal)).length === 1, "pending outbox did not survive reopen");
  const receipt: DurableChatReceipt = {
    receiptId: "host-receipt-1",
    requestId: pending.requestId,
    messageId: "host-message-1",
    eventSequence: 1,
    acceptedAt: "2026-11-05T00:00:00.000Z",
  };
  await rejects(
    () => store.acknowledgePendingChat(scope, pending.requestId, { ...receipt, requestId: "other" }, signal),
    "mismatched receipt cleared the outbox",
  );
  assert((await store.listPendingChats(scope, signal)).length === 1, "mismatched receipt removed outbox item");
  await store.acknowledgePendingChat(scope, pending.requestId, receipt, signal);
  await store.acknowledgePendingChat(scope, pending.requestId, receipt, signal);
  await store.enqueuePendingChat(scope, pending, signal);
  assert((await store.listPendingChats(scope, signal)).length === 0, "matching durable receipt did not clear outbox");
  await rejects(
    () => store.enqueuePendingChat(scope, { ...pending, content: "different acknowledged content" }, signal),
    "acked request id was re-enqueued with changed content",
  );
  await store.close();
  store = await createClientRecoveryStore(profile);
  assert((await store.listPendingChats(scope, signal)).length === 0, "outbox ACK did not survive reopen");
  report.push("outbox persistence and matching durable receipt ACK");

  await store.storeEvent(scope, event(1), signal);
  await store.storeEvent(scope, event(1), signal);
  await rejects(
    () => store.storeEvent(scope, { ...event(1), content: "different" }, signal),
    "same event id accepted changed content",
  );
  await rejects(
    () => store.storeEvent(scope, { ...event(2), messageId: "message-1" }, signal),
    "same message id accepted a different event",
  );
  await rejects(
    () => store.advanceCursor(scope, { scopeKey: "host-scope-a", sequence: 2 }, signal),
    "cursor advanced over missing event",
  );
  await store.storeEvent(scope, event(2), signal);
  await store.advanceCursor(scope, { scopeKey: hostScopeKey, sequence: 2 }, signal);
  await store.close();
  store = await createClientRecoveryStore(profile);
  assert((await store.readCursor(scope, signal))?.sequence === 2, "cursor did not survive reopen");
  await rejects(
    () => store.advanceCursor(scope, { scopeKey: hostScopeKey, sequence: 1 }, signal),
    "cursor moved backwards",
  );
  await rejects(
    () => store.advanceCursor(scope, { scopeKey: "other-host-scope", sequence: 2 }, signal),
    "cursor crossed host scope",
  );
  report.push("event idempotency, conflict rejection, cursor persistence and gap protection");

  await store.replaceSnapshotAndCursor(scope, snapshot(2), snapshot(2).cursor, signal);
  const mismatchedSnapshot = snapshot(3);
  await rejects(
    () =>
      store.replaceSnapshotAndCursor(
        scope,
        { ...mismatchedSnapshot, acceptedRequests: [] },
        mismatchedSnapshot.cursor,
        signal,
      ),
    "incomplete snapshot was accepted",
  );
  await rejects(
    () => store.replaceSnapshotAndCursor(scope, snapshot(1, "wrong-scope"), snapshot(1, "wrong-scope").cursor, signal),
    "snapshot for another scope was accepted",
  );
  const db = new DatabaseSync(join(profile, "message-recovery-v1.sqlite"));
  const key = clientRecoveryScopeKey(scope);
  db.exec(
    `CREATE TRIGGER reject_snapshot_cursor BEFORE UPDATE ON recovery_cursor BEGIN SELECT RAISE(ABORT, 'injected interrupted snapshot'); END`,
  );
  await rejects(
    () => store.replaceSnapshotAndCursor(scope, snapshot(3), snapshot(3).cursor, signal),
    "injected snapshot failure did not fail",
  );
  db.exec("DROP TRIGGER reject_snapshot_cursor");
  const afterFailure = db.prepare("SELECT host_scope_key, sequence FROM recovery_cursor WHERE scope_key=?").get(key);
  const oldAccepted = numberColumn(
    db.prepare("SELECT count(*) AS count FROM inbox_snapshot WHERE scope_key=?").get(key),
    "count",
  );
  assert(
    numberColumn(afterFailure, "sequence") === 2 && oldAccepted === 2,
    "failed snapshot transaction did not roll back all rows and cursor",
  );
  db.close();
  await store.replaceSnapshotAndCursor(scope, snapshot(3), snapshot(3).cursor, signal);
  assert((await store.readCursor(scope, signal))?.sequence === 3, "snapshot cursor was not committed");
  report.push(
    "complete inbox snapshot replacement is atomic and does not turn acceptances into processed conversations",
  );

  await store.enqueuePendingChat(scope, { requestId: "abort-me", target, content: "aborted" }, signal);
  const aborted = new AbortController();
  aborted.abort();
  await rejects(
    () =>
      store.acknowledgePendingChat(
        scope,
        "abort-me",
        {
          receiptId: "host-receipt-aborted",
          requestId: "abort-me",
          messageId: "host-message-aborted",
          eventSequence: 9,
          acceptedAt: "2026-11-05T00:00:00.000Z",
        },
        aborted.signal,
      ),
    "aborted operation committed",
  );
  assert(
    (await store.listPendingChats(scope, signal)).some((row) => isRequest(row, "abort-me")),
    "abort removed pending chat",
  );
  await store.enqueuePendingChat(scopeB, { requestId: "same-id", target, content: "user B" }, signal);
  await store.enqueuePendingChat(scope, { requestId: "same-id", target, content: "user A" }, signal);
  assert(
    (await store.listPendingChats(scopeB, signal))[0] &&
      (await store.listPendingChats(scope, signal)).some((row) => isRequest(row, "same-id")),
    "authorization scopes shared outbox data",
  );
  assert(clientRecoveryScopeKey(scope) !== clientRecoveryScopeKey(scopeB), "scope keys do not include user id");
  report.push("abort-before-commit and account-scope isolation");

  const unknownProfile = join(root, "unknown-profile");
  await mkdir(unknownProfile);
  const unknownDb = join(unknownProfile, "message-recovery-v1.sqlite");
  await writeFile(unknownDb, "preserve unknown database");
  await chmod(unknownDb, 0o644);
  const beforeMode = (await lstat(unknownDb)).mode & 0o777;
  await rejects(() => createClientRecoveryStore(unknownProfile), "unknown database was accepted");
  assert(
    (await lstat(unknownDb)).mode % 0o1000 === beforeMode,
    "unknown database permissions changed before identity validation",
  );
  const linkedProfile = join(root, "linked-profile");
  await mkdir(linkedProfile);
  await symlink(unknownDb, join(linkedProfile, "message-recovery-v1.sqlite"));
  await rejects(() => createClientRecoveryStore(linkedProfile), "database symlink was accepted");
  const hardlinkedProfile = join(root, "hardlinked-profile");
  await mkdir(hardlinkedProfile);
  await link(unknownDb, join(hardlinkedProfile, "message-recovery-v1.sqlite"));
  await rejects(() => createClientRecoveryStore(hardlinkedProfile), "database hardlink was accepted");
  report.push("unknown database preservation and symlink/hardlink rejection");

  store.close();
  const reopened = await createClientRecoveryStore(profile);
  assert((await reopened.readCursor(scope, signal))?.sequence === 3, "final reopen lost cursor");
  reopened.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${report.map((item) => `PASS ${item}`).join("\n")}\n`);
