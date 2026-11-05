import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import { app, BrowserWindow, type BrowserWindowConstructorOptions, protocol, type Session, session } from "electron";
import { runCauseEffect } from "../backend/effect-boundary";
import { type ClientAccountSecureStorage, createClientAccountService } from "./client-account-service";
import { CLIENT_PRODUCT, CLIENT_RENDERER_URL } from "./client-product";
import { registerClientAccountIpc } from "./ipc/client-account-handlers";
import { sendToRenderer } from "./renderer-ipc";

export const CLIENT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  { scheme: "openbot-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

export interface ClientRuntimeOptions {
  apiOrigin: string;
  userDataPath: string;
  rendererRoot: string;
  preloadPath: string;
  secureStorage: ClientAccountSecureStorage;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  onStartupStage?: (stage: ClientRuntimeStartupStage) => void;
  onWindowCreated?: (window: BrowserWindow) => void;
}

export type ClientRuntimeStartupStage =
  | "renderer-root-ready"
  | "account-service-ready"
  | "protocol-ready"
  | "window-created"
  | "window-policy-ready"
  | "ipc-ready"
  | "before-load-url"
  | "after-load-url"
  | "window-shown";

export interface ClientPermissionPolicyBoundary {
  registerRequestHandler(handler: (callback: (allowed: boolean) => void) => void): void;
  registerCheckHandler(handler: () => boolean): void;
}

export interface ClientNavigationEvent {
  preventDefault(): void;
}

export interface ClientNavigationPolicyBoundary {
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  onNavigate(handler: (event: ClientNavigationEvent, targetUrl: string) => void): void;
  onRedirect(handler: (event: ClientNavigationEvent, targetUrl: string) => void): void;
  onFrameNavigation(handler: (event: ClientNavigationEvent, targetUrl: string, isMainFrame: boolean) => void): void;
}

/** Start the account-only client composition after Electron is ready. */
export async function startClientRuntime(options: ClientRuntimeOptions): Promise<void> {
  const rendererRoot = await resolveRendererRoot(options.rendererRoot);
  options.onStartupStage?.("renderer-root-ready");
  const account = createClientAccountService({
    apiOrigin: options.apiOrigin,
    storagePath: join(options.userDataPath, "client-account-session-v1.bin"),
    secureStorage: options.secureStorage,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  options.onStartupStage?.("account-service-ready");

  denyClientSessionPermissions(session.defaultSession);
  session.defaultSession.protocol.handle("openbot-app", (request) => serveClientFile(request, rendererRoot));
  options.onStartupStage?.("protocol-ready");

  const window = new BrowserWindow(clientBrowserWindowOptions(options.preloadPath));
  options.onWindowCreated?.(window);
  options.onStartupStage?.("window-created");

  window.setMenu(null);
  enforceClientNavigation(window.webContents);
  options.onStartupStage?.("window-policy-ready");

  registerClientAccountIpc({ account, window });
  const unsubscribe = account.onChanged((state) => sendToRenderer(window, IPC_ENDPOINTS.auth.event, state));
  window.on("closed", unsubscribe);
  app.on("window-all-closed", () => app.quit());
  options.onStartupStage?.("ipc-ready");

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void runCauseEffect(account.dispose())
      .catch(() => undefined)
      .finally(() => app.quit());
  });

  void runCauseEffect(account.initialize()).catch(() => undefined);
  options.onStartupStage?.("before-load-url");
  await window.loadURL(CLIENT_RENDERER_URL);
  options.onStartupStage?.("after-load-url");
  window.show();
  options.onStartupStage?.("window-shown");
}

export function clientBrowserWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 520,
    height: 620,
    minWidth: 420,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: CLIENT_PRODUCT.productName,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    },
  };
}

export async function serveClientFile(request: Request, rendererRoot: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (
      url.protocol !== "openbot-app:" ||
      url.host !== "app" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      return new Response("Not found", { status: 404 });
    }
    const pathname = decodeURIComponent(url.pathname === "/" ? "/client.html" : url.pathname);
    const filePath = await resolveRendererFile(rendererRoot, pathname);
    const body = request.method === "HEAD" ? null : await readFile(filePath);
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": CLIENT_CONTENT_SECURITY_POLICY,
        "Content-Type": contentType(filePath),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export async function resolveRendererRoot(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The client renderer root is not a regular directory.");
  }
  return realpath(path);
}

export async function resolveRendererFile(root: string, pathname: string): Promise<string> {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    throw new Error("The client renderer path is invalid.");
  }
  const filePath = resolve(root, `.${pathname}`);
  if (!isWithinDirectory(root, filePath)) throw new Error("The client renderer path escaped its root.");
  const relativePath = relative(root, filePath);
  const segments = relativePath.split(sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The client renderer path is invalid.");
  }

  let currentPath = root;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const metadata = await lstat(currentPath);
    if (metadata.isSymbolicLink()) throw new Error("The client renderer contains a symbolic link.");
    const final = index === segments.length - 1;
    if (final ? !metadata.isFile() : !metadata.isDirectory()) {
      throw new Error("The client renderer path is not a regular file.");
    }
    const canonical = await realpath(currentPath);
    if (!isWithinDirectory(root, canonical)) throw new Error("The client renderer path escaped its root.");
    currentPath = canonical;
  }
  return currentPath;
}

function isWithinDirectory(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

/** Refuse every permission request and permission check for the client session. */
export function denyClientSessionPermissions(
  clientSession: Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">,
): void {
  installClientPermissionPolicy({
    registerRequestHandler: (handler) =>
      clientSession.setPermissionRequestHandler((_webContents, _permission, callback) => handler(callback)),
    registerCheckHandler: (handler) => clientSession.setPermissionCheckHandler(() => handler()),
  });
}

/** Keep the one client window on its bundled page and deny every popup or other frame navigation. */
export function enforceClientNavigation(
  webContents: Pick<BrowserWindow["webContents"], "setWindowOpenHandler" | "on">,
): void {
  installClientNavigationPolicy({
    setWindowOpenHandler: (handler) => webContents.setWindowOpenHandler(handler),
    onNavigate: (handler) => webContents.on("will-navigate", (event, targetUrl) => handler(event, targetUrl)),
    onRedirect: (handler) => webContents.on("will-redirect", (event, targetUrl) => handler(event, targetUrl)),
    onFrameNavigation: (handler) =>
      webContents.on("will-frame-navigate", (details) => handler(details, details.url, details.isMainFrame)),
  });
}

export function installClientPermissionPolicy(boundary: ClientPermissionPolicyBoundary): void {
  boundary.registerRequestHandler((callback) => callback(false));
  boundary.registerCheckHandler(() => false);
}

export function installClientNavigationPolicy(boundary: ClientNavigationPolicyBoundary): void {
  boundary.setWindowOpenHandler(() => ({ action: "deny" }));
  boundary.onNavigate((event, targetUrl) => {
    if (targetUrl !== CLIENT_RENDERER_URL) event.preventDefault();
  });
  boundary.onRedirect((event, targetUrl) => {
    if (targetUrl !== CLIENT_RENDERER_URL) event.preventDefault();
  });
  boundary.onFrameNavigation((event, targetUrl, isMainFrame) => {
    if (!isMainFrame || targetUrl !== CLIENT_RENDERER_URL) event.preventDefault();
  });
}

function contentType(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
