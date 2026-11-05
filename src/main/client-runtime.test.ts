// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  app: {},
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {},
}));

import {
  CLIENT_CONTENT_SECURITY_POLICY,
  type ClientNavigationEvent,
  type ClientNavigationPolicyBoundary,
  type ClientPermissionPolicyBoundary,
  clientBrowserWindowOptions,
  installClientNavigationPolicy,
  installClientPermissionPolicy,
  resolveRendererFile,
  resolveRendererRoot,
  serveClientFile,
} from "./client-runtime";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRendererRoot(): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openbot-client-renderer-"));
  temporaryRoots.push(fixtureRoot);
  const root = join(fixtureRoot, "renderer");
  await mkdir(root);
  await writeFile(join(root, "client.html"), "<!doctype html><script src='/client-entry.js'></script>");
  await writeFile(join(root, "client-entry.js"), "document.documentElement.dataset.ready = 'true';");
  await writeFile(join(root, "client-entry.css"), "body { color: white; }");
  return root;
}

describe("client local protocol boundary", () => {
  it("serves only regular files beneath the renderer root with restrictive headers", async () => {
    const root = await createRendererRoot();
    const response = await serveClientFile(new Request("openbot-app://app/client.html"), root);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBe(CLIENT_CONTENT_SECURITY_POLICY);
    expect(CLIENT_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(CLIENT_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CLIENT_CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
    expect(CLIENT_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    expect(CLIENT_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    await expect(response.text()).resolves.toContain("client-entry.js");

    const head = await serveClientFile(new Request("openbot-app://app/client-entry.css", { method: "HEAD" }), root);
    expect(head.status).toBe(200);
    await expect(head.text()).resolves.toBe("");
  });

  it("rejects other origins, query strings, methods, traversal, and symlink targets", async () => {
    const root = await createRendererRoot();
    const outside = join(dirname(root), "outside-secret.js");
    await writeFile(outside, "secret");
    await symlink(outside, join(root, "linked.js"));

    for (const request of [
      new Request("openbot-app://other/client.html"),
      new Request("openbot-app://app/client.html?download=1"),
      new Request("openbot-app://app/client.html", { method: "POST" }),
      new Request("openbot-app://app/%2e%2e%2foutside-secret.js"),
      new Request("openbot-app://app/linked.js"),
    ]) {
      expect((await serveClientFile(request, root)).status).toBe(404);
    }

    await expect(resolveRendererFile(root, "/../outside-secret.js")).rejects.toThrow();
    const symlinkRoot = join(root, "root-alias");
    await symlink(root, symlinkRoot);
    await expect(resolveRendererRoot(symlinkRoot)).rejects.toThrow("not a regular directory");

    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "safe.js"), "safe");
    await expect(readFile(join(nested, "safe.js"), "utf8")).resolves.toBe("safe");
  });
});

describe("client window trust boundary", () => {
  it("keeps renderer Node access off and requires isolation, sandboxing, and web security", () => {
    const options = clientBrowserWindowOptions("/client/preload/client-index.cjs");

    expect(options.webPreferences).toEqual({
      preload: "/client/preload/client-index.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    });
  });

  it("denies permission requests and permission checks", () => {
    let permissionRequest: ((callback: (allowed: boolean) => void) => void) | undefined;
    let permissionCheck: (() => boolean) | undefined;
    const boundary: ClientPermissionPolicyBoundary = {
      registerRequestHandler: (handler) => (permissionRequest = handler),
      registerCheckHandler: (handler) => (permissionCheck = handler),
    };
    installClientPermissionPolicy(boundary);

    let granted = true;
    permissionRequest?.((result) => (granted = result));
    expect(granted).toBe(false);
    expect(permissionCheck?.()).toBe(false);
  });

  it("denies popups, off-page navigation, redirects, and every subframe navigation", () => {
    let openHandler: (() => { action: "deny" }) | undefined;
    let navigate: ((event: ClientNavigationEvent, targetUrl: string) => void) | undefined;
    let redirect: ((event: ClientNavigationEvent, targetUrl: string) => void) | undefined;
    let frameNavigate: ((event: ClientNavigationEvent, targetUrl: string, isMainFrame: boolean) => void) | undefined;
    const boundary: ClientNavigationPolicyBoundary = {
      setWindowOpenHandler: (handler) => (openHandler = handler),
      onNavigate: (handler) => (navigate = handler),
      onRedirect: (handler) => (redirect = handler),
      onFrameNavigation: (handler) => (frameNavigate = handler),
    };
    installClientNavigationPolicy(boundary);

    expect(openHandler?.()).toEqual({ action: "deny" });
    const externalNavigation = (listener: typeof navigate) => {
      let prevented = false;
      listener?.({ preventDefault: () => (prevented = true) }, "https://example.com");
      expect(prevented).toBe(true);
    };
    externalNavigation(navigate);
    externalNavigation(redirect);

    let exactPagePrevented = false;
    navigate?.({ preventDefault: () => (exactPagePrevented = true) }, "openbot-app://app/client.html");
    expect(exactPagePrevented).toBe(false);

    let subframePrevented = false;
    frameNavigate?.({ preventDefault: () => (subframePrevented = true) }, "openbot-app://app/client.html", false);
    expect(subframePrevented).toBe(true);
  });
});
