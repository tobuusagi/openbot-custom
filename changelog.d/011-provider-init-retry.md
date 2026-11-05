In opt-in always-on mode, Codex and Antigravity retry typed timeouts during provider initialization
with a separate backoff episode. Authentication, permanent configuration, unknown initialization,
process-exit, and turn-request failures keep their existing behavior. The runtime waits for
Antigravity's owned temporary directory to be removed before starting its replacement and preserves
the 1 GiB free-space guard.

After 24 hours, the provider row shows a warning while slow retries continue. This first
implementation pauses after an interim, process-local cap of 48 launches until the user reconnects.
That cap is not a daily limit, and this change does not complete Plan 011 Stage 5: the exact installed
CLI versions still need an initialization fault-injection soak on the target Windows Surface.
Uncertain turn submissions remain interrupted when history cannot prove their result and are never
replayed.
