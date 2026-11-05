import type { AgentProvider } from "./agent-client";

export type ProviderLifecycleMode = "desktop" | "always-on";

/** Phase 1A retains Codex and Antigravity processes and Antigravity sessions. */
export function providerLifecycleModeFor(
  provider: AgentProvider,
  requested: ProviderLifecycleMode,
): ProviderLifecycleMode {
  return requested === "always-on" && (provider === "codex" || provider === "antigravity") ? requested : "desktop";
}

/** Reads the local provider-host policy without exposing an untrusted value in its error. */
export function readProviderLifecycleMode(environment: NodeJS.ProcessEnv): ProviderLifecycleMode {
  const value = environment.OPENBOT_PROVIDER_LIFECYCLE;
  if (value === undefined || value === "desktop") return "desktop";
  if (value === "always-on") return "always-on";
  throw new Error("OPENBOT_PROVIDER_LIFECYCLE must be unset, 'desktop', or 'always-on'.");
}
