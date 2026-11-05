import type { ClientAccountApi } from "@openbot/contracts/ipc";

declare global {
  interface Window {
    clientAccount: ClientAccountApi;
  }
}
