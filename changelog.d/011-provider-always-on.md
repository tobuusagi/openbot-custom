The local Agent Host can opt in to a persistent Provider lifecycle with
`OPENBOT_PROVIDER_LIFECYCLE=always-on`. The default `desktop` mode keeps its current idle timers.
Always-on keeps Codex and Antigravity processes, and Antigravity ACP sessions, open until an
explicit stop, logout, restart, or an eligible memory-pressure release. Other Providers keep their
desktop idle-release behavior.

Provider crash and initialization retry limits stay unchanged. Phase 1A does not extend retries for
transient network errors because the current failure path cannot safely distinguish those errors
from authentication, configuration, or CLI failures. Codex app-server SDK retries also stay under the
SDK's existing policy. Longer host restart windows need a later change with provider-specific failure
evidence.
