# Feitu desktop client runtime handoff

**Status: design seam only.** The current Feitu package is a scaffold and is not a usable client.

The desktop `src/main/index.ts` always constructs the full `ApplicationServices` graph. That graph
starts provider runtimes and owns the local Host. The development remote-client role still enters
that graph. The desktop renderer's `AppProviders` also defaults to the local server and its preload
exposes the complete `OpenBotDesktopApi`. Neither is a valid pure-client entry.

The separate package currently points to `src/main/client-index.ts`. That entry imports only Electron
and the closed product metadata in `src/main/client-product.ts`; it exits with status 78 while the
client runtime is incomplete. The package build does not include the existing Host entry, desktop
preload, renderer, or extra resources. If the dedicated entry is missing, packaging fails.

The existing renderer seam to reuse is the browser client: `WebApp`, `WebWorkspace`, and
`createWebWorkspaceRuntime`. That path connects to a remote Host through Team API and WebRTC and
does not need `window.openbot`. A future client renderer should mount that path, not `App` or
`AppProviders`. `WebApp` currently assumes same-origin browser-cookie authentication, while
`createWebWorkspaceRuntime` takes its account origin from `window.location.origin`. A packaged
renderer therefore needs an explicit account transport for `https://api.feitu.net.cn` and a reviewed
credential boundary. Do not solve this by exposing the desktop preload or by accepting arbitrary
URLs from renderer input.

The client preload is not present. When a reviewed account transport is ready, it must expose only
the narrow account calls the client needs. The future persistent device grant for local files and
terminal access is a separate capability and needs its own security review. This scaffold does not
implement either capability, WSS, or update installation. Its update feed is null, and the build has
no GitHub updater fallback.
