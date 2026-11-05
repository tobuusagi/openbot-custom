import { createHash } from "node:crypto";
import {
  decodeHostChatAcceptRequest,
  decodeHostChatConsumeRequest,
  decodeHostChatCursor,
  decodeHostChatRecoveryScope,
  HOST_CHAT_RECOVERY_CAPABILITY,
  HOST_CHAT_RECOVERY_ROUTES,
  type HostChatCursor,
} from "@openbot/contracts/team-protocol/host-chat-recovery-v1";
import { sourceText } from "@openbot/i18n/source";

const HOST_CHAT_RECOVERY_ROUTE_SET: ReadonlySet<string> = new Set(Object.values(HOST_CHAT_RECOVERY_ROUTES));

import { AgentLifecycleFailed } from "../../backend/agent-service";
import {
  HostChatRecoveryError,
  type HostChatRecoveryScope,
  type HostChatRecoveryTarget,
} from "../../backend/database/host-chat-recovery";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiHostChatRecovery, TeamApiHostChatRecoveryAuthority } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

function decode<A>(decodeValue: (value: unknown) => A, value: unknown): A {
  try {
    return decodeValue(value);
  } catch {
    throw new HttpError(400, sourceText("error.team.agentNotFound"));
  }
}

function validAuthority(
  value: TeamApiHostChatRecoveryAuthority | undefined,
): value is TeamApiHostChatRecoveryAuthority {
  return (
    !!value &&
    [value.hostEpoch, value.authEpoch, value.grantEpoch].every((epoch) => Number.isSafeInteger(epoch) && epoch > 0)
  );
}

function scopeFor(
  context: TeamApiRequestContext,
  authority: TeamApiHostChatRecoveryAuthority,
  hostId: string,
  recovery: TeamApiHostChatRecovery,
  currentAccessRevision: () => number,
  currentMemberAuthorizationRevision: (memberId: string) => number,
): HostChatRecoveryScope | null {
  const current = context.currentSession();
  if (!current) return null;
  const accessRevision = currentAccessRevision();
  const memberRevision = currentMemberAuthorizationRevision(current.member.id);
  if (
    !Number.isSafeInteger(accessRevision) ||
    accessRevision < 0 ||
    !Number.isSafeInteger(memberRevision) ||
    memberRevision < 0
  )
    return null;
  const logicalSessionId = `team-session:${current.sessionId}`;
  const accessState = recovery
    .listAgents()
    .map((agent) => [agent.id, context.currentAgentLevel(agent.id)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const authGeneration =
    Number.parseInt(
      createHash("sha256")
        .update(JSON.stringify([authority.authEpoch, accessRevision, memberRevision, current.member.role, accessState]))
        .digest("hex")
        .slice(0, 13),
      16,
    ) || 1;
  return decodeHostChatRecoveryScope({
    hostId,
    userId: current.member.id,
    deviceId: logicalSessionId,
    grantId: logicalSessionId,
    capability: "chat",
    hostEpoch: authority.hostEpoch,
    authEpoch: authGeneration,
    grantEpoch: authority.grantEpoch,
  });
}

const agentAccessRank = (level: string): number => ({ none: 0, view: 1, chat: 2, manage: 3 })[level] ?? 0;
const apiError = (status: number): HttpError => new HttpError(status, sourceText("error.team.agentNotFound"));

/**
 * Authenticated logical Team session recovery. Every scope component comes from the Host's
 * identity, current authenticated session, member, and explicit Host authority configuration.
 */
export async function routeHostChatRecovery(
  context: TeamApiRequestContext,
  recovery: TeamApiHostChatRecovery | undefined,
  authority: TeamApiHostChatRecoveryAuthority | undefined,
  hostId: string | undefined,
  hiddenAgentIds: ReadonlySet<string>,
  currentAccessRevision: () => number,
  currentMemberAuthorizationRevision: (memberId: string) => number,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  const expectedMethod =
    url.pathname === HOST_CHAT_RECOVERY_ROUTES.scope ||
    url.pathname === HOST_CHAT_RECOVERY_ROUTES.events ||
    url.pathname === HOST_CHAT_RECOVERY_ROUTES.snapshot
      ? "GET"
      : "POST";
  if (!HOST_CHAT_RECOVERY_ROUTE_SET.has(url.pathname) || method !== expectedMethod) return "unmatched";
  if (
    context.protocol < 9 ||
    !capabilities.has(HOST_CHAT_RECOVERY_CAPABILITY) ||
    !validAuthority(authority) ||
    !hostId ||
    !recovery
  ) {
    throw new HttpError(400, sourceText("error.backend.threadRemoteUnsupported"));
  }
  const scope = scopeFor(
    context,
    authority,
    hostId,
    recovery,
    currentAccessRevision,
    currentMemberAuthorizationRevision,
  );
  if (!scope) throw new HttpError(401, sourceText("error.team.authenticationRequired"));
  const authorize = (candidate: HostChatRecoveryScope, target?: HostChatRecoveryTarget): boolean => {
    if (
      candidate.hostId !== scope.hostId ||
      candidate.userId !== scope.userId ||
      candidate.deviceId !== scope.deviceId ||
      candidate.grantId !== scope.grantId ||
      candidate.hostEpoch !== scope.hostEpoch ||
      candidate.authEpoch !== scope.authEpoch ||
      candidate.grantEpoch !== scope.grantEpoch ||
      candidate.capability !== "chat"
    )
      return false;
    const currentScope = scopeFor(
      context,
      authority,
      hostId,
      recovery,
      currentAccessRevision,
      currentMemberAuthorizationRevision,
    );
    if (
      !currentScope ||
      currentScope.hostId !== scope.hostId ||
      currentScope.userId !== scope.userId ||
      currentScope.deviceId !== scope.deviceId ||
      currentScope.grantId !== scope.grantId ||
      currentScope.hostEpoch !== scope.hostEpoch ||
      currentScope.authEpoch !== scope.authEpoch ||
      currentScope.grantEpoch !== scope.grantEpoch
    )
      return false;
    if (!target) return true;
    if (hiddenAgentIds.has(target.agentId) || agentAccessRank(context.currentAgentLevel(target.agentId)) < 2)
      return false;
    return (
      recovery.listAgents().some((agent) => agent.id === target.agentId) &&
      recovery.isDurableHostChatTarget(target.agentId, target.threadId)
    );
  };

  if (method === "GET" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.scope) return json(200, scope);

  if (method === "POST" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.accept) {
    const input = decode(decodeHostChatAcceptRequest, await readJson(request));
    if (hiddenAgentIds.has(input.target.agentId)) throw apiError(404);
    if (agentAccessRank(context.currentAgentLevel(input.target.agentId)) < 2) throw apiError(403);
    if (
      !recovery.listAgents().some((agent) => agent.id === input.target.agentId) ||
      !recovery.isDurableHostChatTarget(input.target.agentId, input.target.threadId)
    )
      throw apiError(404);
    try {
      return json(202, recovery.recordDurableHostChatRequest({ scope, ...input }, authorize));
    } catch (error) {
      if (error instanceof HostChatRecoveryError) {
        if (error.code === "UNAUTHORIZED") throw apiError(404);
        if (error.code === "INVALID_INPUT" || error.code === "REQUEST_ID_CONFLICT")
          throw new HttpError(400, sourceText("error.team.agentNotFound"));
      }
      throw error;
    }
  }

  if (method === "POST" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.consume) {
    const { requestId } = decode(decodeHostChatConsumeRequest, await readJson(request));
    try {
      const receipt = await runCauseEffect(recovery.sendDurableHostChat({ scope, requestId, authorize }));
      return json(200, receipt);
    } catch (error) {
      if (error instanceof HostChatRecoveryError && (error.code === "UNAUTHORIZED" || error.code === "INVALID_INPUT"))
        throw apiError(404);
      if (error instanceof AgentLifecycleFailed && error.cause instanceof HostChatRecoveryError) {
        if (error.cause.code === "UNAUTHORIZED" || error.cause.code === "INVALID_INPUT") throw apiError(404);
      }
      throw error;
    }
  }

  if (method === "GET" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.events) {
    const encoded = url.searchParams.get("after");
    let after: HostChatCursor | undefined;
    if (encoded !== null) {
      try {
        after = decode(decodeHostChatCursor, JSON.parse(encoded));
      } catch {
        throw new HttpError(400, sourceText("error.team.agentNotFound"));
      }
    }
    try {
      const page = recovery.readDurableHostChatEvents(scope, after, authorize);
      if (page.status === "snapshot-required" && page.reason === "authorization-changed") throw apiError(404);
      return json(200, page);
    } catch (error) {
      if (error instanceof HostChatRecoveryError && error.code === "UNAUTHORIZED") throw apiError(404);
      throw error;
    }
  }

  if (method === "GET" && url.pathname === HOST_CHAT_RECOVERY_ROUTES.snapshot) {
    try {
      return json(200, recovery.readDurableHostChatSnapshot(scope, authorize));
    } catch (error) {
      if (error instanceof HostChatRecoveryError && error.code === "UNAUTHORIZED") throw apiError(404);
      throw error;
    }
  }

  return "unmatched";
}
