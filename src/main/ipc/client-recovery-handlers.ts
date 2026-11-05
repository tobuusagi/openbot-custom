import { sourceText } from "@openbot/i18n/source";
import { MessageRecoveryError } from "@openbot/team-client/message-recovery";
import type { IpcMainInvokeEvent } from "electron";
import { CLIENT_RENDERER_URL } from "../client-product";
import type { ClientRecoveryService } from "../client-recovery-service";
import { authorizedHandler, type IpcGroupHandlers, registerIpcGroupSubset } from "./define-ipc-group";
import { isObject, requireString } from "./validation";

type ClientRecoveryHandlers = IpcGroupHandlers["clientRecovery"];

const RECOVERY_MESSAGE_BYTES = 786_432;
const SAFE_RECOVERY_ERROR = () => new Error(sourceText("error.remote.connectionStepFailed"));

function parseChat(value: unknown) {
  if (!isObject(value) || Object.keys(value).length !== 2 || !isObject(value.target)) {
    throw SAFE_RECOVERY_ERROR();
  }
  if (Object.keys(value.target).length !== 2) throw SAFE_RECOVERY_ERROR();
  let agentId: string;
  let threadId: string;
  let content: string;
  try {
    agentId = requireString(value.target.agentId, "agentId", 256);
    threadId = requireString(value.target.threadId, "threadId", 256);
    content = requireString(value.content, "content", RECOVERY_MESSAGE_BYTES);
  } catch {
    throw SAFE_RECOVERY_ERROR();
  }
  if (new TextEncoder().encode(content).byteLength > RECOVERY_MESSAGE_BYTES) {
    throw SAFE_RECOVERY_ERROR();
  }
  return {
    target: { agentId, threadId },
    content,
  };
}

async function safeOperation<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch (error) {
    const message =
      error instanceof MessageRecoveryError && error.code === "transport-permanent"
        ? sourceText("error.remote.sessionInvalid")
        : error instanceof MessageRecoveryError && error.code === "cancelled"
          ? sourceText("error.remote.sessionEnded")
          : sourceText("error.remote.connectionStepFailed");
    throw new Error(message);
  }
}

export interface ClientRecoveryIpcWindow {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    mainFrame: { url: string };
  };
}

export function registerClientRecoveryIpc(service: ClientRecoveryService, window: ClientRecoveryIpcWindow): void {
  registerIpcGroupSubset(
    "clientRecovery",
    ["getState", "sendChat", "recover"],
    clientRecoveryIpcHandlers(service, window),
  );
}

export function clientRecoveryIpcHandlers(
  service: ClientRecoveryService,
  window: ClientRecoveryIpcWindow,
): ClientRecoveryHandlers {
  const authorize = (event: IpcMainInvokeEvent): void => {
    const frame = event.senderFrame;
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender !== window.webContents ||
      event.sender.id !== window.webContents.id ||
      !frame ||
      frame !== window.webContents.mainFrame ||
      frame.url !== CLIENT_RENDERER_URL
    ) {
      throw SAFE_RECOVERY_ERROR();
    }
  };
  const noPayload = (value: unknown): undefined => {
    if (value !== undefined) throw SAFE_RECOVERY_ERROR();
    return undefined;
  };
  return {
    getState: authorizedHandler(authorize, noPayload, () => service.getState()),
    sendChat: authorizedHandler(authorize, parseChat, (_event, input) => {
      if (service.getState().status !== "ready") throw new Error(sourceText("error.remote.remoteNotConfigured"));
      return safeOperation(() => service.sendChat(input.target, input.content));
    }),
    recover: authorizedHandler(authorize, noPayload, () => safeOperation(() => service.recover())),
  };
}

/** Closed surface in the full Host product; only the isolated client composition registers active handlers. */
export function unavailableClientRecoveryIpcHandlers(): ClientRecoveryHandlers {
  const deny = () => {
    throw SAFE_RECOVERY_ERROR();
  };
  const noPayload = (value: unknown): undefined => {
    if (value !== undefined) throw SAFE_RECOVERY_ERROR();
    return undefined;
  };
  return {
    getState: authorizedHandler(deny, noPayload, () => ({ status: "not-connected" })),
    sendChat: authorizedHandler(deny, parseChat, () => Promise.reject(SAFE_RECOVERY_ERROR())),
    recover: authorizedHandler(deny, noPayload, () => undefined),
  };
}
