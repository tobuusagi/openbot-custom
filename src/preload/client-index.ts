import type { ClientAccountApi } from "@openbot/contracts/ipc";
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import { contextBridge, ipcRenderer } from "electron";
import { decodeCentralAuthState } from "./app-decoding";

const clientAccount: ClientAccountApi = {
  getState: () => ipcRenderer.invoke(IPC_ENDPOINTS.auth.getState.channel).then(decodeCentralAuthState),
  retry: () => ipcRenderer.invoke(IPC_ENDPOINTS.auth.retry.channel).then(decodeCentralAuthState),
  requestEmailCode: (email) =>
    ipcRenderer.invoke(IPC_ENDPOINTS.auth.requestEmailCode.channel, email).then(decodeCentralAuthState),
  verifyEmailCode: (input) =>
    ipcRenderer.invoke(IPC_ENDPOINTS.auth.verifyEmailCode.channel, input).then(decodeCentralAuthState),
  logout: () => ipcRenderer.invoke(IPC_ENDPOINTS.auth.logout.channel).then(decodeCentralAuthState),
  onEvent: (listener) => listenAuthState(listener),
};

contextBridge.exposeInMainWorld("clientAccount", Object.freeze(clientAccount));

function listenAuthState(listener: Parameters<ClientAccountApi["onEvent"]>[0]): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
    try {
      listener(decodeCentralAuthState(value));
    } catch {
      // A malformed main-process event does not cross into the renderer.
    }
  };
  ipcRenderer.on(IPC_ENDPOINTS.auth.event.channel, handler);
  return () => ipcRenderer.removeListener(IPC_ENDPOINTS.auth.event.channel, handler);
}
