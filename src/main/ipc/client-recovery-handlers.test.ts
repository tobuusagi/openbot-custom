// @vitest-environment node

import type { ClientRecoveryState } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_RENDERER_URL } from "../client-product";
import type { ClientRecoveryService } from "../client-recovery-service";
import { type ClientRecoveryIpcWindow, registerClientRecoveryIpc } from "./client-recovery-handlers";

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

function createWindow(): {
  window: ClientRecoveryIpcWindow;
  sender: { id: number; isDestroyed: () => false; mainFrame: { url: string } };
} {
  const sender = { id: 17, isDestroyed: () => false as const, mainFrame: { url: CLIENT_RENDERER_URL } };
  return { sender, window: { isDestroyed: () => false, webContents: sender } };
}

function invoke(channel: string, event: unknown, payload?: unknown): Promise<string | ClientRecoveryState | undefined> {
  const listener = registrations.get(channel);
  if (!listener) throw new Error(`No listener registered for ${channel}.`);
  const result = listener(event, payload);
  if (!(result instanceof Promise)) throw new Error("The client recovery invoke handler did not return a promise.");
  return result.then((value: unknown) => {
    if (typeof value === "string" || value === undefined || isClientRecoveryState(value)) return value;
    throw new Error("The client recovery invoke handler returned an invalid result.");
  });
}

function isClientRecoveryState(value: unknown): value is ClientRecoveryState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("status" in value)) return false;
  if (value.status === "not-connected") return true;
  return value.status === "ready" && "phase" in value && typeof value.phase === "string";
}

describe("client recovery IPC authorization", () => {
  beforeEach(() => registrations.clear());

  it("rejects a different window and frame before decoding or invoking the service", () => {
    const { window, sender } = createWindow();
    const service = {
      getState: vi.fn(() => ({ status: "ready" as const, phase: "idle" as const })),
      onState: vi.fn(() => () => undefined),
      sendChat: vi.fn(async () => "request-id"),
      recover: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } satisfies ClientRecoveryService;
    registerClientRecoveryIpc(service, window);
    for (const event of [
      { sender: { ...sender, id: 18 }, senderFrame: sender.mainFrame },
      { sender, senderFrame: { url: "openbot-app://app/other.html" } },
      { sender, senderFrame: null },
    ]) {
      expect(() => invoke("client-recovery:send-chat", event, { invalid: true })).toThrow();
    }
    expect(service.sendChat).not.toHaveBeenCalled();
  });

  it("accepts only a chat target and content from the exact client page", async () => {
    const { window, sender } = createWindow();
    const service = {
      getState: vi.fn(() => ({ status: "ready" as const, phase: "idle" as const })),
      onState: vi.fn(() => () => undefined),
      sendChat: vi.fn(async () => "request-id"),
      recover: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } satisfies ClientRecoveryService;
    registerClientRecoveryIpc(service, window);
    const event = { sender, senderFrame: sender.mainFrame };
    const chat = { target: { agentId: "agent-1", threadId: "thread-1" }, content: "hello" };
    await expect(invoke("client-recovery:send-chat", event, chat)).resolves.toBe("request-id");
    expect(service.sendChat).toHaveBeenCalledWith(chat.target, chat.content);
    for (const payload of [
      { ...chat, scope: {} },
      { ...chat, url: "wss://attacker.example" },
      { ...chat, token: "secret" },
      { ...chat, content: "é".repeat(393_217) },
    ]) {
      expect(() => invoke("client-recovery:send-chat", event, payload)).toThrow();
    }
    vi.mocked(service.sendChat).mockRejectedValueOnce(new Error("/private/profile/recovery.sqlite: SQL failure"));
    await expect(Promise.resolve(invoke("client-recovery:send-chat", event, chat))).rejects.toThrow(
      sourceText("error.remote.connectionStepFailed"),
    );
    expect(service.sendChat).toHaveBeenCalledTimes(2);
  });
});
