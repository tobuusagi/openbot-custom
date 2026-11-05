// @vitest-environment node

import type { CentralAuthState, VerifyEmailCodeInput } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientAccountService } from "../client-account-service";
import { CLIENT_RENDERER_URL } from "../client-product";
import { type ClientAccountIpcWindow, registerClientAccountIpc } from "./client-account-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const SIGNED_OUT: CentralAuthState = { status: "signed_out" };

function createAccount(): ClientAccountService {
  return {
    initialize: () => Effect.succeed(SIGNED_OUT),
    getState: () => SIGNED_OUT,
    retry: () => Effect.succeed(SIGNED_OUT),
    requestEmailCode: () => Effect.succeed(SIGNED_OUT),
    verifyEmailCode: (_input: VerifyEmailCodeInput) => Effect.succeed(SIGNED_OUT),
    logout: () => Effect.succeed(SIGNED_OUT),
    onChanged: () => () => undefined,
    dispose: () => Effect.void,
  };
}

function createWindow(): {
  window: ClientAccountIpcWindow;
  sender: { id: number; isDestroyed: () => false; mainFrame: { url: string } };
} {
  const sender = {
    id: 41,
    isDestroyed: () => false as const,
    mainFrame: { url: CLIENT_RENDERER_URL },
  };
  return {
    sender,
    window: {
      isDestroyed: () => false,
      webContents: sender,
    },
  };
}

function invoke(channel: string, event: unknown, payload?: unknown): CentralAuthState | Promise<CentralAuthState> {
  const listener = registrations.get(channel);
  if (!listener) throw new Error(`No listener is registered for ${channel}.`);
  const result = listener(event, payload);
  return result instanceof Promise ? result.then(decodeTestAccountState) : decodeTestAccountState(result);
}

function decodeTestAccountState(value: unknown): CentralAuthState {
  if (typeof value === "object" && value !== null && "status" in value && value.status === "signed_out") {
    return SIGNED_OUT;
  }
  throw new Error("The test IPC handler did not return the expected account state.");
}

describe("client account IPC authorization", () => {
  beforeEach(() => registrations.clear());

  it("registers only the five account request endpoints", () => {
    const { window } = createWindow();
    registerClientAccountIpc({ account: createAccount(), window });

    expect([...registrations.keys()].sort()).toEqual([
      "auth:get-state",
      "auth:logout",
      "auth:request-email-code",
      "auth:retry",
      "auth:verify-email-code",
    ]);
  });

  it("requires this window, its main frame, and the exact client page before decoding", () => {
    const { window, sender } = createWindow();
    const account = createAccount();
    const requestEmailCode = vi.spyOn(account, "requestEmailCode");
    registerClientAccountIpc({ account, window });

    const wrongWindowSender = { ...sender, id: sender.id + 1 };
    const wrongFrame = { url: CLIENT_RENDERER_URL };
    const wrongPathFrame = { url: "openbot-app://app/other.html" };
    for (const event of [
      { sender: wrongWindowSender, senderFrame: wrongWindowSender.mainFrame },
      { sender, senderFrame: wrongFrame },
      { sender, senderFrame: wrongPathFrame },
    ]) {
      expect(() => invoke("auth:request-email-code", event, { malformed: true })).toThrow(
        "Rejected IPC request outside the client renderer.",
      );
    }

    expect(requestEmailCode).not.toHaveBeenCalled();
  });

  it("decodes a request after the exact client main frame is authorized", async () => {
    const { window, sender } = createWindow();
    const account = createAccount();
    const requestEmailCode = vi.spyOn(account, "requestEmailCode");
    registerClientAccountIpc({ account, window });
    const event = { sender, senderFrame: sender.mainFrame };

    await expect(Promise.resolve(invoke("auth:request-email-code", event, "person@example.test"))).resolves.toEqual(
      SIGNED_OUT,
    );
    expect(requestEmailCode).toHaveBeenCalledOnce();
    expect(requestEmailCode).toHaveBeenCalledWith("person@example.test");
    expect(() => invoke("auth:request-email-code", event, { malformed: true })).toThrow("email is required.");
    expect(requestEmailCode).toHaveBeenCalledOnce();
  });
});
