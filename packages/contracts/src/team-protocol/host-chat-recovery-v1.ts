import { Result, Schema } from "effect";
import { INPUT_LIMITS } from "../input-limits";

/** Additive recovery for authenticated Team API sessions. Protocol 9 only. */
export const HOST_CHAT_RECOVERY_CAPABILITY = "host-chat-recovery-v1";

export const HOST_CHAT_RECOVERY_ROUTES = {
  scope: "/v1/host-chat/scope",
  accept: "/v1/host-chat/accept",
  consume: "/v1/host-chat/consume",
  events: "/v1/host-chat/events",
  snapshot: "/v1/host-chat/snapshot",
} as const;

const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(INPUT_LIMITS.identifier));
const content = Schema.String.check(Schema.isMaxLength(786_432));
const timestamp = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const sequence = Schema.Number;

export const HostChatTarget = Schema.Struct({ agentId: identifier, threadId: identifier });
export const HostChatAcceptRequest = Schema.Struct({
  target: HostChatTarget,
  requestId: identifier,
  content,
});
export const HostChatConsumeRequest = Schema.Struct({ requestId: identifier });
export const HostChatRecoveryScope = Schema.Struct({
  hostId: identifier,
  userId: identifier,
  deviceId: identifier,
  grantId: identifier,
  capability: Schema.Literal("chat"),
  hostEpoch: sequence,
  authEpoch: sequence,
  grantEpoch: sequence,
});
export const HostChatCursor = Schema.Struct({
  scopeKey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  sequence,
});
export const HostChatReceipt = Schema.Struct({
  receiptId: identifier,
  requestId: identifier,
  messageId: identifier,
  eventSequence: sequence,
  acceptedAt: timestamp,
});
export const HostChatRecoveryEvent = Schema.Struct({
  sequence,
  messageId: identifier,
  requestId: identifier,
  target: HostChatTarget,
  content,
  occurredAt: timestamp,
});
export const HostChatEventPage = Schema.Struct({
  status: Schema.Literal("events"),
  events: Schema.Array(HostChatRecoveryEvent).check(Schema.isMaxLength(100)),
  cursor: HostChatCursor,
  hasMore: Schema.Boolean,
});
export const HostChatSnapshotRequired = Schema.Struct({
  status: Schema.Literal("snapshot-required"),
  reason: Schema.Literals(["scope-changed", "cursor-ahead", "event-gap", "authorization-changed", "event-too-large"]),
});
export const HostChatInboxSnapshot = Schema.Struct({
  type: Schema.Literal("host-chat-inbox-snapshot"),
  complete: Schema.Literal(true),
  acceptedRequests: Schema.Array(
    Schema.Struct({
      sequence,
      messageId: identifier,
      requestId: identifier,
      target: HostChatTarget,
      content,
      acceptedAt: timestamp,
    }),
  ).check(Schema.isMaxLength(500)),
  cursor: HostChatCursor,
});

export const HostChatQueuedReceipt = Schema.Struct({
  messageId: identifier,
  deliveries: Schema.Array(
    Schema.Struct({
      id: identifier,
      recipientAgentId: identifier,
      status: Schema.Literals(["queued", "starting", "running", "completed", "failed", "interrupted", "cancelled"]),
      position: Schema.Union([Schema.Null, Schema.Number]),
    }),
  ).check(Schema.isMaxLength(50)),
});
export type HostChatQueuedReceipt = typeof HostChatQueuedReceipt.Type;
export type HostChatAcceptRequest = typeof HostChatAcceptRequest.Type;
export type HostChatConsumeRequest = typeof HostChatConsumeRequest.Type;
export type HostChatTarget = typeof HostChatTarget.Type;
export type HostChatRecoveryScope = typeof HostChatRecoveryScope.Type;
export type HostChatCursor = typeof HostChatCursor.Type;
export type HostChatReceipt = typeof HostChatReceipt.Type;
export type HostChatRecoveryEvent = typeof HostChatRecoveryEvent.Type;
export type HostChatEventPage = typeof HostChatEventPage.Type;
export type HostChatSnapshotRequired = typeof HostChatSnapshotRequired.Type;
export type HostChatInboxSnapshot = typeof HostChatInboxSnapshot.Type;

function strictDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  validate?: (value: S["Type"]) => void,
): (value: unknown) => S["Type"] {
  const decode = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" });
  return (value) => {
    const result = decode(value);
    if (Result.isSuccess(result)) {
      validate?.(result.success);
      return result.success;
    }
    throw new Error("Invalid Host chat recovery response.");
  };
}

const isSafeInteger = (value: number, minimum: number): boolean => Number.isSafeInteger(value) && value >= minimum;
const validId = (value: string): boolean => value.length > 0 && value.length <= INPUT_LIMITS.identifier;
const validContent = (value: string): boolean => new TextEncoder().encode(value).byteLength <= 786_432;
const validTime = (value: string): boolean => Number.isFinite(Date.parse(value));
const validateCursor = (cursor: HostChatCursor): void => {
  if (!/^[0-9a-f]{64}$/u.test(cursor.scopeKey) || !isSafeInteger(cursor.sequence, 0)) throw new Error("invalid cursor");
};
const validateScope = (scope: HostChatRecoveryScope): void => {
  if (
    ![scope.hostId, scope.userId, scope.deviceId, scope.grantId].every(validId) ||
    ![scope.hostEpoch, scope.authEpoch, scope.grantEpoch].every((epoch) => isSafeInteger(epoch, 1))
  )
    throw new Error("invalid scope");
};
const validateReceipt = (receipt: HostChatReceipt): void => {
  if (
    ![receipt.receiptId, receipt.requestId, receipt.messageId].every(validId) ||
    !isSafeInteger(receipt.eventSequence, 1) ||
    !validTime(receipt.acceptedAt)
  )
    throw new Error("invalid receipt");
};
const validateEvent = (event: HostChatRecoveryEvent): void => {
  if (
    ![event.messageId, event.requestId, event.target.agentId, event.target.threadId].every(validId) ||
    !isSafeInteger(event.sequence, 1) ||
    !validContent(event.content) ||
    !validTime(event.occurredAt)
  )
    throw new Error("invalid event");
};
const validateQueuedReceipt = (receipt: HostChatQueuedReceipt): void => {
  if (
    !validId(receipt.messageId) ||
    receipt.deliveries.some(
      (item) =>
        !validId(item.id) ||
        !validId(item.recipientAgentId) ||
        (item.position !== null && !isSafeInteger(item.position, 1)),
    )
  )
    throw new Error("invalid queued receipt");
};

export const decodeHostChatAcceptRequest = strictDecoder(HostChatAcceptRequest, (input) => {
  if (
    !validId(input.target.agentId) ||
    !validId(input.target.threadId) ||
    !validId(input.requestId) ||
    !validContent(input.content)
  )
    throw new Error("invalid acceptance");
});
export const decodeHostChatConsumeRequest = strictDecoder(HostChatConsumeRequest, (input) => {
  if (!validId(input.requestId)) throw new Error("invalid consume request");
});
export const decodeHostChatCursor = strictDecoder(HostChatCursor, validateCursor);
export const decodeHostChatReceipt = strictDecoder(HostChatReceipt, validateReceipt);
export const decodeHostChatRecoveryScope = strictDecoder(HostChatRecoveryScope, validateScope);
export const decodeHostChatEventPage = strictDecoder(
  Schema.Union([HostChatEventPage, HostChatSnapshotRequired]),
  (page) => {
    if (page.status === "events") {
      validateCursor(page.cursor);
      page.events.forEach(validateEvent);
    }
  },
);
export const decodeHostChatInboxSnapshot = strictDecoder(HostChatInboxSnapshot, (snapshot) => {
  validateCursor(snapshot.cursor);
  for (const item of snapshot.acceptedRequests) {
    if (
      ![item.messageId, item.requestId, item.target.agentId, item.target.threadId].every(validId) ||
      !isSafeInteger(item.sequence, 1) ||
      !validContent(item.content) ||
      !validTime(item.acceptedAt)
    )
      throw new Error("invalid snapshot item");
  }
});
export const decodeHostChatQueuedReceipt = strictDecoder(HostChatQueuedReceipt, validateQueuedReceipt);
