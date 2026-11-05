import {
  decodeHostChatEventPage,
  decodeHostChatInboxSnapshot,
  decodeHostChatQueuedReceipt,
  decodeHostChatReceipt,
  decodeHostChatRecoveryScope,
  HOST_CHAT_RECOVERY_ROUTES,
  type HostChatCursor,
  type HostChatInboxSnapshot,
  type HostChatQueuedReceipt,
  type HostChatRecoveryScope,
} from "@openbot/contracts/team-protocol/host-chat-recovery-v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { MessageRecoveryTransport } from "./message-recovery";

/** A trusted request adapter reports the HTTP status before it discards the response. */
export class AuthenticatedTeamApiRequestError extends Error {
  constructor(readonly status: number) {
    super("Authenticated Team API request failed.");
    this.name = "AuthenticatedTeamApiRequestError";
  }
}

/** This boundary is new and cancellable. It does not change the released TeamApiRequest contract. */
export type AuthenticatedTeamApiRequest = <T>(
  method: string,
  path: string,
  decode: (value: unknown) => T,
  body?: TeamProtocolV2Json,
  signal?: AbortSignal,
) => Promise<T>;

export class AuthenticatedHostChatRecoveryTransportError extends Error {
  readonly code: "response-invalid" | "transport-permanent" | "transport-cancelled";

  constructor(code: AuthenticatedHostChatRecoveryTransportError["code"]) {
    super("Authenticated Host chat recovery request failed.");
    this.name = "AuthenticatedHostChatRecoveryTransportError";
    this.code = code;
  }
}

export type AuthenticatedHostChatRecoveryFailure = "temporary" | "permanent" | "cancelled";

/** Classify only local decode errors, trusted typed status errors, and the platform abort signal. */
export function classifyAuthenticatedHostChatRecoveryTransportFailure(
  error: unknown,
): AuthenticatedHostChatRecoveryFailure {
  if (error instanceof AuthenticatedHostChatRecoveryTransportError) {
    if (error.code === "transport-cancelled") return "cancelled";
    return "permanent";
  }
  if (error instanceof AuthenticatedTeamApiRequestError) {
    return [400, 401, 403, 404].includes(error.status) ? "permanent" : "temporary";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return "temporary";
}

function decodeAs<A>(decode: (value: unknown) => A): (value: unknown) => A {
  return (value) => {
    try {
      return decode(value);
    } catch {
      throw new AuthenticatedHostChatRecoveryTransportError("response-invalid");
    }
  };
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthenticatedHostChatRecoveryTransportError("transport-cancelled");
}

/**
 * Uses one already authenticated Host request binding. Scope is fetched from the Host's authenticated
 * metadata route and is never sent back in a write or read request. Every operation forwards abort.
 */
export interface AuthenticatedHostChatRecoveryTransport extends MessageRecoveryTransport {
  readScope(signal?: AbortSignal): Promise<HostChatRecoveryScope>;
  consume(requestId: string, signal: AbortSignal): Promise<HostChatQueuedReceipt>;
}

export function createAuthenticatedHostChatRecoveryTransport(
  request: AuthenticatedTeamApiRequest,
): AuthenticatedHostChatRecoveryTransport {
  return {
    async readScope(signal) {
      checkSignal(signal);
      const scope = await request(
        "GET",
        HOST_CHAT_RECOVERY_ROUTES.scope,
        decodeAs(decodeHostChatRecoveryScope),
        undefined,
        signal,
      );
      checkSignal(signal);
      return scope;
    },

    async recordDurableChatRequest(input, signal) {
      checkSignal(signal);
      const receipt = await request(
        "POST",
        HOST_CHAT_RECOVERY_ROUTES.accept,
        decodeAs(decodeHostChatReceipt),
        { target: input.target, requestId: input.requestId, content: input.content },
        signal,
      );
      checkSignal(signal);
      // Keep the outbox entry pending until the Host confirms idempotent delivery into its real queue.
      // A lost or temporary consume reply retries accept and consume with the same request ID.
      await this.consume(input.requestId, signal);
      checkSignal(signal);
      return receipt;
    },

    async consume(requestId, signal) {
      checkSignal(signal);
      const receipt = await request(
        "POST",
        HOST_CHAT_RECOVERY_ROUTES.consume,
        decodeAs(decodeHostChatQueuedReceipt),
        { requestId },
        signal,
      );
      checkSignal(signal);
      return receipt;
    },

    async readEvents(_scope, afterCursor, signal) {
      checkSignal(signal);
      const query = afterCursor
        ? `?after=${encodeURIComponent(JSON.stringify(afterCursor satisfies HostChatCursor))}`
        : "";
      const page = await request(
        "GET",
        `${HOST_CHAT_RECOVERY_ROUTES.events}${query}`,
        decodeAs(decodeHostChatEventPage),
        undefined,
        signal,
      );
      checkSignal(signal);
      return page;
    },

    async readChatInboxSnapshot(_scope, signal) {
      checkSignal(signal);
      const snapshot = await request(
        "GET",
        HOST_CHAT_RECOVERY_ROUTES.snapshot,
        decodeAs(decodeHostChatInboxSnapshot),
        undefined,
        signal,
      );
      checkSignal(signal);
      return snapshot satisfies HostChatInboxSnapshot;
    },
  };
}
