export interface ClientRecoveryState {
  status: "not-connected" | "ready";
  phase?: "idle" | "recovering" | "waiting" | "stopped";
}

export interface ClientRecoveryChatInput {
  target: { agentId: string; threadId: string };
  content: string;
}
