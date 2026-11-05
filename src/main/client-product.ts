/**
 * The closed identity of the Feitu client package. These values are part of the product build and
 * cannot be changed through the user's environment.
 *
 * This product has a local account shell only. Workspace and device capabilities are not part of
 * this runtime. Keep `runtimeStatus` closed until those paths are implemented.
 */
export const CLIENT_MAIN_SOURCE = "src/main/client-index.ts";
export const CLIENT_MAIN_ARTIFACT = "out-client/main/client-index.js";
export const CLIENT_PRELOAD_ARTIFACT = "out-client/preload/client-index.cjs";
export const CLIENT_RENDERER_HTML = "out-client/renderer/client.html";
export const CLIENT_RENDERER_ENTRY = "out-client/renderer/client-entry.js";
export const CLIENT_RENDERER_STYLES = "out-client/renderer/client-entry.css";
export const CLIENT_RENDERER_URL = "openbot-app://app/client.html";
export const CLIENT_RENDERER_ORIGIN = "openbot-app://app";

type ClientProduct = {
  readonly role: "client";
  readonly runtimeStatus: "account-shell";
  readonly applicationId: "cn.net.feitu.openbot.client";
  readonly productName: "FeituOpenBotClient";
  readonly executableName: "FeituOpenBotClient";
  readonly protocolScheme: "feitu-openbot";
  readonly defaultApiOrigin: "https://api.feitu.net.cn";
  readonly defaultConnectOrigin: "wss://connect.feitu.net.cn";
  readonly updateChannel: "feitu-openbot-client";
  readonly updateFeed: null;
};

export const CLIENT_PRODUCT: ClientProduct = {
  role: "client",
  runtimeStatus: "account-shell",
  applicationId: "cn.net.feitu.openbot.client",
  productName: "FeituOpenBotClient",
  executableName: "FeituOpenBotClient",
  protocolScheme: "feitu-openbot",
  defaultApiOrigin: "https://api.feitu.net.cn",
  defaultConnectOrigin: "wss://connect.feitu.net.cn",
  updateChannel: "feitu-openbot-client",
  updateFeed: null,
};
