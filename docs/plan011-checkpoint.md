# Plan 011 checkpoint

Status: 2026-11-05. This is a source-only implementation checkpoint. The ignored `TASKS.md` and
`.openbot-build/` stay local, so this file records the current handoff. No deployment, signing, DNS
change, production data migration, or release has occurred. The work is not production ready.

## Verified slices

- The local account gateway passed a native Node 24.22.1 and SQLite 3.53.4 E2E for initialization,
  repository operations, local email-code login, session revocation, request limits, and shutdown.
  Biome and the `auth-api` project typecheck also passed on that code state. Later gateway changes
  still need a fresh E2E run.
- The Android Expo configuration E2E passed 12/12 checks, with changed-file lint and independent
  review. This covers configuration only. Native builds, devices, Firebase/FCM, and the external
  `openbot://` link producer remain unverified.
- The client package verifier and real-ASAR boundary E2E passed. The protected IPC/security tests
  passed 23/23, and renderer typecheck passed before the latest asset and runtime changes. These
  results do not establish a usable client login flow.
- Earlier provider baseline cases passed with fake CLIs. They do not establish the current extended
  initialization-retry behavior.
- The relocated memory-only Noise experiment passed 36/36 across Node, Bun, and Chromium, with
  package lint, typecheck, and independent review. This verifies the memory-only experiment only.

## Current work and next steps

- **Gateway and SMTP:** The SMTP-only E2E now passes valid TLS delivery, untrusted CA rejection,
  hostname mismatch rejection, aggregate reply limits, reply line limits, and disconnect before
  the TLS handshake (8 ms). The mismatch fixture had retained `localhost` as its CN; its separate
  certificate now uses `wrong.invalid`. Production TLS verification was not relaxed. Fixture socket
  cleanup also prevents shutdown hangs. Changed-file Biome and the `auth-api` typecheck passed.
  Evidence: `.openbot-build/011-gateway-smtp-e2e.json`. The full gateway E2E was not rerun;
  its earlier failed report is retained. SMTP settings are pending; no real email was sent.
- **Desktop client:** The authenticated Xvfb runtime E2E now passes the local health check, email-code
  request and verification, signed-in profile read, and logout. It verifies one CSS file and six WebP
  files against the renderer asset allowlist, removes its test profile and bundle, and writes
  `.openbot-build/client-runtime-e2e/report.json`. The package configuration verifier and real-ASAR
  boundary E2E also pass; a native package build remains unverified.
- **Provider retry:** The focused lost-reply case now passes. A written `turn/start` whose reply is
  lost is treated as an uncertain result; the delivery ends as `interrupted` and is not submitted
  again after recovery. The retained report records exactly one turn submission. Evidence:
  `.openbot-build/stuck-running-deliveries-e2e/report.json`, case `i`. Keep retries opt-in for
  Codex and Antigravity, bounded, and unable to replay submitted work. Live OAuth and Surface
  operation remain unverified.
  The next focused `persistent-retry` fake-CLI case passes: 49 initialization replies are withheld,
  then Codex recovers on launch 50. The interim 48-launch stop is removed. A warning does not stop
  recovery; auth/unknown refusal, disk launch prevention, refresh/dispose cancellation and a
  single-process assertion pass. Production backoff and timeouts are unchanged. Node typecheck
  and changed-file Biome pass. Only this selected case ran; skipped cases and legacy aggregate
  fields in `.openbot-build/provider-always-on-e2e/report.json` are not new evidence. The latest
  summary-field assignment is metadata-only and was not a reason to rerun the passing case.
- **Noise/WSS:** The new local loopback WebSocket harness passes 7/7 checks: Noise handshake,
  encrypted messages in both directions, a fresh session after reconnect, old-session ciphertext
  rejection, wrong-identity rejection, and tamper rejection. The experiment typecheck and changed-file
  Biome check pass. Evidence: `.openbot-build/011-noise-spike/loopback-websocket-report.json`.
  The earlier memory-only checks were not rerun. This does not implement product WSS, TLS, public
  relay, persistent replay, device grants, or delivery receipts.
  `docs/architecture/011-wss-development-adapter.md` now defines a bounded local adapter proposal:
  identity pairing, framing, session confirmation, epoch/lease checks, receipts and cursor scopes.
  These are specifications, not implemented product features or a change to the security verdict.
- **Message recovery model:** `experiments/011-message-recovery` adds a separate temporary SQLite
  model. Its 18 assertions and directory TypeScript check pass on Node 24.22.1 / SQLite 3.53.4.
  The model commits fixture message, receipt and event atomically, computes request hashes from
  scope and content, rejects conflicting IDs, and preserves the original receipt after injected
  pre/post-commit failures and close/reopen. It checks authorization before numbering events,
  separates grant/epoch cursor scopes and requests a snapshot on scope changes or gaps.
  Only factory-owned temporary databases are accepted; foreign schemas and unsafe paths are
  rejected. Evidence: `experiments/011-message-recovery/validation-evidence.txt`.
  This is fault injection, not a physical power-loss test. Product `openbot.db` integration,
  snapshot generation, lease enforcement and complete client reconnect delivery remain open.
- **ECS templates:** The service files and runbook are drafts. Validate their startup and credential
  loading model before any separate deployment request. No deployment check has run.
  A local opt-in systemd credential reader now maps eight fixed filenames, with bounded reads,
  regular-file checks, safe resource cleanup, strict UTF-8 decoding and redacted errors. Its focused
  E2E, changed-file lint and the auth-api typecheck pass. Evidence:
  `.openbot-build/systemd-credentials-e2e.json`. Real credential provisioning and host systemd
  verification remain open. The unit has no credential source paths and cannot be deployed as-is.
  `deploy/feitu-ecs/preflight.py` adds read-only draft text checks, not full Caddy/systemd validation
  or deployment approval. It always reports the unresolved deployment blockers and exits nonzero.
  Four narrow tool checks pass: the current draft, a non-loopback listener fixture, a malformed
  matcher, and invalid UTF-8. Evidence: `.openbot-build/minimax-delegation/preflight-check.json`.
- **Mobile:** Native ARM builds, device checks, Firebase/FCM setup, and external link opening remain
  separate open tasks. `docs/feitu-fcm-setup.md` records setup and device acceptance steps;
  it does not implement the Surface FCM sender or provision Firebase.
  The new local public Firebase configuration validator passes nine fixture checks without reading
  real credentials or contacting Google. Evidence:
  `.openbot-build/minimax-delegation/round2-tool-checks.json`. The Surface launcher sets only a
  child-inherited process lifecycle variable and restores it afterward; Windows execution remains
  unverified because this environment has no PowerShell. See `docs/feitu-surface-host.md`.

This round and the retained prior work are being committed to `codex/plan011-client-ecs-wip` at the
user's request. The user explicitly requires Git-only sync without repeated checks or reviews.
No deployment, production operation, or native-device validation is implied. The checked-in
deployment templates remain drafts, and `connect.feitu.net.cn` still returns 503.
