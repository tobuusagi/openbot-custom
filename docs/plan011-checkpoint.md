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
  This is fault injection, not a physical power-loss test. The later main-database inbox and
  snapshot and delivery work below supersede the model's storage limitation. Authenticated route
  wiring, lease enforcement and complete client integration remain open.
- **Host database inbox:** The real `OpenBotDatabase` now exposes opt-in
  `recordDurableChatRequest` and `readDurableChatEvents` operations. Additive migration 56 creates
  scoped inbox, receipt and event tables without changing existing conversation data. An authorized
  request binds its agent/thread target and content; all three records commit atomically, retries
  return the original receipt, and changed targets or content are rejected. Reads check current
  target authorization and return at most 100 events and 1 MiB per page, advancing only to the last
  returned event. The Host E2E passes 12 steps; v56 migration boundaries pass 3/3, schema parity 4/4,
  and released-schema data-preservation fixtures 8/8. Evidence:
  `.openbot-build/011-host-message-recovery-e2e/report.json`. Other migration tests had only their
  current-latest-version expectations maintained; those suites were not rerun locally.
  This is durable inbox acceptance. The later opt-in delivery entry below can consume it through
  the existing queue; an acceptance receipt alone still does not imply Provider execution.
- **Portable receiving core:** `@openbot/team-client/message-recovery` now provides an opt-in
  controller with injected platform storage and transport. Only a durable Host receipt acknowledges
  the outbox. Event persistence precedes cursor advancement; paging, replay conflicts, concurrent
  outbox draining and cancellation of late responses are covered. Its new E2E passes 12 checks,
  including a real temporary Host database, reply loss after commit, original-receipt retry and
  bounded paging of 406 events. Evidence: `.openbot-build/011-client-message-recovery-e2e.json`.
  Changed-file Biome and the final shared Node typecheck pass. This uses an in-process test bridge,
  not IPC or WSS. The later desktop persistence and backend delivery entries below implement those
  components; authenticated transport and desktop/mobile/web wiring remain open.
- **Inbox snapshots and retry scheduling:** `readDurableChatSnapshot` reads the accepted inbox
  records and cursor from one consistent main-database read transaction. It checks current target
  authorization and returns a complete snapshot only within 500 records and 1 MiB; larger snapshots
  fail explicitly, with no partial body or cursor. Its five new E2E checks pass, including a
  concurrent writer and event-gap recovery. Evidence:
  `.openbot-build/011-host-chat-snapshot-e2e/report.json`.
  The receiving controller validates and atomically installs this real snapshot. Its opt-in
  scheduler uses injected time/timers/jitter, retries temporary failures from a 500 ms base up to
  30 seconds, continues after a 24-hour warning, resets the outage period after recovery, and stops
  on trusted permanent failure or cancellation. Logout/revoke/dispose cancel work; old generations
  cannot overwrite a restarted run. Ten new scheduler/snapshot checks, changed-file Biome and the
  final shared Node typecheck pass. Evidence:
  `.openbot-build/011-client-recovery-scheduler-e2e.json`. Earlier passing suites were not rerun.
  These snapshots describe inbox acceptance only. Paginated larger snapshots, actual conversation
  and Provider result recovery, authenticated platform transport, mobile/web persistence and UI
  remain open.
- **Inbox-to-delivery bridge:** The new opt-in `AgentService.sendDurableHostChat` reads its target,
  content and hash from the authoritative accepted inbox row and rechecks current authorization and
  thread identity. Migration 57 adds a permanent delivery ledger. MailboxStore owns one transaction
  for the ledger and real mailbox queue projection, restores memory/change sets on rollback, and
  publishes post-enqueue effects only after commit. Duplicate requests return the stored receipt
  before Provider startup, even after mailbox history cleanup. Queued work resumes through the
  existing startup drain path; queue acceptance is not a claim of Provider execution success.
  The real AgentService/SQLite/fake-Codex E2E passes 7/7 checks for conversation delivery, lost replies,
  restart retry, concurrent duplicates, rejection, rollback and retained receipts. Evidence:
  `.openbot-build/011-host-chat-delivery-e2e/report.json`. Focused migration boundaries and schema
  parity pass (8 tests total), and released-schema data-preservation fixtures pass 8/8 for v57.
  Changed-file Biome and the final shared Node typecheck pass. No live
  model, OAuth or user database was used. The later authenticated routes below invoke this API
  only when the Host explicitly enables the new logical-session capability.
- **Desktop recovery persistence:** `src/main/client-recovery-store.ts` implements the portable
  store contract in a separate versioned, profile-local SQLite database. Pending requests, receipts,
  events, cursor and complete inbox snapshots survive close/reopen; duplicate acknowledgement is
  idempotent and conflicting content is rejected. Commit checks cancellation, snapshot/cursor
  replacement is atomic, and unsafe links or unknown schemas are rejected before modification.
  The new desktop E2E passes five assertion groups. Its runner is
  `scripts/011-desktop-recovery-store-e2e.ts` (stdout evidence); changed-file Biome and the final
  shared Node typecheck pass. The later runtime composition below now owns this adapter. Packaged
  ARM64 applications, Mac/Windows devices and native filesystem permissions remain unverified.
- **Authenticated Host chat routes:** Protocol 9 gains the opt-in `host-chat-recovery-v1` capability
  with separate frozen codecs and fixtures. The existing authenticated Team API serves scope
  bootstrap, accept, consume, paged events and snapshots. Scope comes from Host identity, the current
  logical session/member and explicit server-owned authority configuration; clients cannot supply
  it. Session validity and current target permissions are checked again before dispatch. The
  transport retains pending work across accept/consume failures and returns acceptance to the
  controller only after idempotent queue consumption is confirmed. Temporary server errors remain
  retryable; trusted authorization failures stop recovery, and cancellation reaches the request.
  Real HTTP, real Host/client services and SQLite, with FakeCodex, pass 23 retained report checks.
  Evidence: `.openbot-build/011-authenticated-chat-recovery-e2e/report.json`.
  A new optional persisted member authorization revision prevents permission downgrade/restore
  from reopening an old namespace; four focused compatibility/merge tests pass. Earlier HTTP cases
  were not rerun after those focused merge/type/lint edits. Final shared Node typecheck passes.
  This authority is a logical Team-session namespace, not a physical device, WSS peer grant or
  monotonic cryptographic boot epoch. The capability remains disabled without explicit configuration.
- **Client runtime and IPC composition:** `startClientRuntime` now owns the SQLite recovery
  service, binds it to account identity/sign-in/out/expiry and shutdown, and registers protected
  state/send/recover IPC with preload and preview mirrors. Renderer input cannot choose a URL,
  token or scope; only a main-owned authenticated Host connection resolver can supply a transport.
  Logout cancels resolution and in-flight requests; stale generations and delayed teardown cannot
  overwrite or close a replacement connection. Runtime E2E passes all 13 result flags and new IPC
  sender/payload/redaction boundary tests pass. Evidence:
  `.openbot-build/011-client-recovery-runtime-e2e/report.json`.
  The package config verifier, real-ASAR boundary E2E, renderer typecheck, changed-file Biome and
  final shared Node typecheck pass. No full native package build or physical device check ran.
  The shipped client entry does not configure a Host-session resolver, so its safe default is
  `not-connected`; account API tokens are never substituted for Host Team sessions. The product
  remains an account shell with opt-in recovery composition, not a complete receiving-client UI.
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

The previous round was committed and pushed as `7900fdb6d` on `codex/plan011-client-ecs-wip`.
The later inbox, delivery, authenticated-route and client composition changes remain local. The user explicitly
requires Git-only sync without repeated checks or reviews when a sync is requested. No deployment,
production operation, or native-device validation is implied. Deployment templates remain drafts,
and `connect.feitu.net.cn` still returns 503.
