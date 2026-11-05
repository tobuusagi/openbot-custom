import type { ClientAccountApi, ClientRecoveryApi } from "@openbot/contracts/ipc";

declare global {
  interface Window {
    clientAccount: ClientAccountApi;
    clientRecovery: ClientRecoveryApi;
  }
}
