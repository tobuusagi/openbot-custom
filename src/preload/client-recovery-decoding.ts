import type { ClientRecoveryState } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export function decodeClientRecoveryState(value: unknown): ClientRecoveryState {
  if (!isDynamicRecord(value)) throw new TypeError("Client recovery state is invalid.");
  const state = value;
  if (state.status === "not-connected" && Object.keys(state).length === 1) return { status: "not-connected" };
  if (
    state.status === "ready" &&
    Object.keys(state).length === 2 &&
    (state.phase === "idle" || state.phase === "recovering" || state.phase === "waiting" || state.phase === "stopped")
  ) {
    return { status: "ready", phase: state.phase };
  }
  throw new TypeError("Client recovery state is invalid.");
}

export function decodeClientRecoveryRequestId(value: unknown): string {
  if (!isString(value) || value.length < 1 || value.length > 128) {
    throw new TypeError("Client recovery request id is invalid.");
  }
  return value;
}
