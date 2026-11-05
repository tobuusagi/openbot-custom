import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { IpcMainInvokeEvent } from "electron";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { ClientAccountService } from "../client-account-service";
import { CLIENT_RENDERER_URL } from "../client-product";
import { parseEmailCodeVerification } from "./app-inputs";
import { authorizedHandler, type IpcGroupHandlers, registerIpcGroupSubset } from "./define-ipc-group";
import { stringPayload } from "./validation";

const CLIENT_ACCOUNT_ENDPOINTS = ["getState", "retry", "requestEmailCode", "verifyEmailCode", "logout"] as const;
type ClientAccountEndpoint = (typeof CLIENT_ACCOUNT_ENDPOINTS)[number];
type ClientAccountHandlers = Pick<IpcGroupHandlers["auth"], ClientAccountEndpoint>;

export interface ClientAccountIpcDependencies {
  account: ClientAccountService;
  window: ClientAccountIpcWindow;
}

export interface ClientAccountIpcWindow {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    mainFrame: { url: string };
  };
}

/** Bind only the account subset used by the separate client renderer. */
export function registerClientAccountIpc(dependencies: ClientAccountIpcDependencies): void {
  registerIpcGroupSubset("auth", CLIENT_ACCOUNT_ENDPOINTS, clientAccountIpcHandlers(dependencies));
}

export function clientAccountIpcHandlers({ account, window }: ClientAccountIpcDependencies): ClientAccountHandlers {
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
      throw new Error("Rejected IPC request outside the client renderer.");
    }
  };

  const noPayload = (value: unknown): undefined => {
    if (value !== undefined) throw new Error("This IPC endpoint does not accept a payload.");
    return undefined;
  };

  return {
    getState: authorizedHandler(authorize, noPayload, () => account.getState()),
    retry: authorizedHandler(authorize, noPayload, () => runCauseEffect(account.retry())),
    requestEmailCode: authorizedHandler(authorize, stringPayload("email", INPUT_LIMITS.email), (_event, email) =>
      runCauseEffect(account.requestEmailCode(email)),
    ),
    verifyEmailCode: authorizedHandler(authorize, parseEmailCodeVerification, (_event, input) =>
      runCauseEffect(account.verifyEmailCode(input)),
    ),
    logout: authorizedHandler(authorize, noPayload, () => runCauseEffect(account.logout())),
  };
}
