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

- **Gateway and SMTP:** The latest request-trigger, body-limit, and TLS-fixture changes passed
  Biome (26 files) and the `auth-api` typecheck after two assertion fixes. The local E2E has not run
  against these latest edits. Run it next. Confirm the SMTP reply caps, relay rejection, listener
  cleanup, and Node TLS CA fixture. SMTP settings are pending; no real email was sent.
- **Desktop client:** The authenticated Xvfb runtime E2E now passes the local health check, email-code
  request and verification, signed-in profile read, and logout. It verifies one CSS file and six WebP
  files against the renderer asset allowlist, removes its test profile and bundle, and writes
  `.openbot-build/client-runtime-e2e/report.json`. The package configuration verifier and real-ASAR
  boundary E2E also pass; a native package build remains unverified.
- **Provider retry:** The latest lifecycle run passed the busy-hook case, then failed the lost-reply
  delivery assertion: it observed `failed` where the check expected `interrupted`. Resolve the
  outcome and cleanup behavior, then rerun the lifecycle E2E and Node project typecheck. Keep retries
  opt-in for Codex and Antigravity, bounded, and unable to replay submitted work.
- **Noise/WSS:** Implement and check only the local loopback WebSocket harness. Product WSS remains
  out of scope and unapproved.
- **ECS templates:** The service files and runbook are drafts. Validate their startup and credential
  loading model before any separate deployment request. No deployment check has run.
- **Mobile:** Native ARM builds, device checks, Firebase/FCM setup, and external link opening remain
  separate open tasks.

The required staged pre-commit checks are the next source validation gate. Their result must not be
used to claim the E2E or production checks above have passed.
