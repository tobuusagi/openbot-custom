import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { RecoveryStore, RecoveryStoreError, SimulatedCrashError, type ChatScope } from "./store.ts";

const scope: ChatScope = {
  hostId: "host-a",
  userId: "user-a",
  deviceId: "device-a",
  grantId: "grant-a",
  capability: "chat",
  hostEpoch: 3,
  authEpoch: 5,
  grantEpoch: 7,
};
const otherGrant = { ...scope, grantId: "grant-b" };
let allowed = false;
let store: RecoveryStore | undefined;

try {
  store = RecoveryStore.createTemporary((candidate) => allowed && candidate.userId === "user-a");
  let active = store;
  const descriptorsBeforeUnownedPath = countOpenFileDescriptors();
  assert.throws(() => Reflect.construct(RecoveryStore, ["/tmp/not-to-be-opened.sqlite", () => true, {}, Symbol("unowned"), true]), (error: unknown) => error instanceof RecoveryStoreError && error.code === "INVALID_INPUT");
  assert.equal(countOpenFileDescriptors(), descriptorsBeforeUnownedPath, "unowned paths must be rejected before opening SQLite");
  assert.throws(() => active.appendChat(scope, { requestId: "denied", content: "secret" }), (error: unknown) => error instanceof RecoveryStoreError && error.code === "UNAUTHORIZED");
  active.close();
  active = active.reopen();
  store = active;
  allowed = true;

  assert.throws(() => active.appendChat(scope, { requestId: "req-before", content: "fixture:before" }, "before-commit"), SimulatedCrashError);
  active.close();
  active = active.reopen();
  store = active;
  const first = active.appendChat(scope, { requestId: "req-before", content: "fixture:before" });
  assert.equal(first.eventSequence, 1, "a pre-commit crash must roll back the event sequence");
  assert.deepEqual(active.appendChat(scope, { requestId: "req-before", content: "fixture:before" }), first);
  assert.throws(() => active.appendChat(scope, { requestId: "req-before", content: "different body" }), (error: unknown) => error instanceof RecoveryStoreError && error.code === "REQUEST_ID_CONFLICT");

  assert.throws(() => active.appendChat(scope, { requestId: "req-after", content: "fixture:after" }, "after-commit-before-return"), SimulatedCrashError);
  active.close();
  active = active.reopen();
  store = active;
  const second = active.appendChat(scope, { requestId: "req-after", content: "fixture:after" });
  assert.equal(second.eventSequence, 2, "a committed request must keep its receipt after restart");
  assert.equal(active.readEvents(scope).status, "events");

  const other = active.appendChat(otherGrant, { requestId: "req-other-grant", content: "fixture:other-scope" });
  assert.equal(other.eventSequence, 1, "a different grant has its own cursor sequence");
  const otherEvents = active.readEvents(otherGrant);
  assert.equal(otherEvents.status, "events");
  if (otherEvents.status === "events") assert.deepEqual(otherEvents.events.map((event) => event.content), ["fixture:other-scope"]);
  const currentEvents = active.readEvents(scope);
  assert.equal(currentEvents.status, "events");
  if (currentEvents.status !== "events") throw new Error("Expected authorized events.");
  const changedEpoch = active.readEvents({ ...scope, authEpoch: scope.authEpoch + 1 }, currentEvents.cursor);
  assert.equal(changedEpoch.status, "snapshot-required");
  active.deleteFixtureEventForScenario(scope, 1);
  active.close();
  active = active.reopen();
  store = active;
  const gap = active.readEvents(scope);
  assert.deepEqual(gap, { status: "snapshot-required", reason: "event-gap" });
  active.replaceOwnedDatabaseWithNonFixtureForScenario();
  const descriptorsBeforeRejectedOpen = countOpenFileDescriptors();
  assert.throws(() => active.reopen(), (error: unknown) => error instanceof RecoveryStoreError && error.code === "INVALID_INPUT");
  assert.equal(countOpenFileDescriptors(), descriptorsBeforeRejectedOpen, "a rejected non-fixture open must close its SQLite handle");
  console.log("011-message-recovery fixture scenarios passed");
} finally {
  store?.dispose();
}

function countOpenFileDescriptors(): number | undefined {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return undefined;
  }
}
