import { randomUUID } from "node:crypto";
import type { ClientRecoveryState as IpcClientRecoveryState } from "@openbot/contracts/ipc";
import {
  type AuthenticatedTeamApiRequest,
  classifyAuthenticatedHostChatRecoveryTransportFailure,
  createAuthenticatedHostChatRecoveryTransport,
} from "@openbot/team-client/host-chat-recovery-transport";
import {
  createMessageRecoveryController,
  createMessageRecoveryScheduler,
  MessageRecoveryError,
  type MessageRecoveryScope,
} from "@openbot/team-client/message-recovery";
import type { ClientAccountService } from "./client-account-service";
import { createClientRecoveryStore } from "./client-recovery-store";

export type ClientRecoveryState = IpcClientRecoveryState;

export interface ClientAuthenticatedRecoveryConnection {
  /** A Team API request already bound to the selected authenticated Host session. */
  request: AuthenticatedTeamApiRequest;
  close(): Promise<void> | void;
}

export interface ClientRecoveryService {
  getState(): ClientRecoveryState;
  onState(listener: (state: ClientRecoveryState) => void): () => void;
  activate(connection: ClientAuthenticatedRecoveryConnection | null): Promise<void>;
  sendChat(target: { agentId: string; threadId: string }, content: string): Promise<string>;
  recover(): Promise<void>;
  dispose(): Promise<void>;
}

/** Account identity gates the main-only Host-session resolver; account credentials never leave it. */
export function bindClientRecoveryAccountLifecycle(
  account: Pick<ClientAccountService, "getState" | "onChanged">,
  recovery: Pick<ClientRecoveryService, "activate">,
  resolveAuthenticatedHostRecovery?: (
    accountSubject: string,
    signal: AbortSignal,
  ) => Promise<ClientAuthenticatedRecoveryConnection | null>,
): () => void {
  let generation = 0;
  let resolverAbort: AbortController | undefined;
  const closeQuietly = async (connection: ClientAuthenticatedRecoveryConnection | null) => {
    try {
      await connection?.close();
    } catch {
      // A stale Host session must not surface a close failure to the client renderer.
    }
  };
  const apply = (state: ReturnType<ClientAccountService["getState"]>) => {
    const current = ++generation;
    resolverAbort?.abort();
    resolverAbort = undefined;
    // `activate(null)` invalidates and detaches the old transport synchronously before its first await.
    const invalidation = recovery.activate(null).catch(() => undefined);
    if (state.status !== "signed_in" || !resolveAuthenticatedHostRecovery) {
      return;
    }
    const abort = new AbortController();
    resolverAbort = abort;
    void (async () => {
      await invalidation;
      if (current !== generation || abort.signal.aborted) return;
      let connection: ClientAuthenticatedRecoveryConnection | null = null;
      try {
        connection = await resolveAuthenticatedHostRecovery(state.user.id, abort.signal);
        if (current !== generation || abort.signal.aborted) {
          await closeQuietly(connection);
          return;
        }
        await recovery.activate(connection);
        connection = null;
      } catch {
        await closeQuietly(connection);
        if (current === generation) await recovery.activate(null).catch(() => undefined);
      }
    })().catch(() => undefined);
  };
  const unsubscribe = account.onChanged(apply);
  apply(account.getState());
  return () => {
    generation += 1;
    resolverAbort?.abort();
    resolverAbort = undefined;
    unsubscribe();
    void recovery.activate(null).catch(() => undefined);
  };
}

/** Owns recovery storage and work for one pure-client runtime. No account token enters this service. */
export async function createClientRecoveryService(options: {
  profilePath: string;
  onState?: (state: ClientRecoveryState) => void;
}): Promise<ClientRecoveryService> {
  const store = await createClientRecoveryStore(options.profilePath);
  let state: ClientRecoveryState = { status: "not-connected" };
  const listeners = new Set<(state: ClientRecoveryState) => void>();
  let active:
    | {
        token: number;
        controller: ReturnType<typeof createMessageRecoveryController>;
        scheduler: ReturnType<typeof createMessageRecoveryScheduler>;
        close: () => Promise<void>;
      }
    | undefined;
  let pendingConnection: { close(): Promise<void>; abort(): void } | undefined;
  let disposed = false;
  let disposeFlight: Promise<void> | undefined;
  let activation = 0;
  const closeQuietly = async (connection: ClientAuthenticatedRecoveryConnection) => {
    try {
      await connection.close();
    } catch {
      // A failed close must not keep the client recovery service alive during account teardown.
    }
  };
  const publish = (next: ClientRecoveryState) => {
    state = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // Observer failures cannot interrupt recovery or resource teardown.
      }
    }
    try {
      options.onState?.(next);
    } catch {
      // Observer failures cannot interrupt recovery or resource teardown.
    }
  };
  const deactivate = async () => {
    const pending = pendingConnection;
    const previous = active;
    pendingConnection = undefined;
    active = undefined;
    pending?.abort();
    previous?.scheduler.logout();
    await Promise.all([pending?.close(), previous?.close()]);
  };
  return {
    getState: () => state,
    onState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate: async (connection) => {
      const token = ++activation;
      await deactivate();
      if (disposed || token !== activation) {
        if (connection) await closeQuietly(connection);
        return;
      }
      publish({ status: "not-connected" });
      if (!connection) return;
      let connectionClosed = false;
      const closeConnection = async () => {
        if (connectionClosed) return;
        connectionClosed = true;
        await closeQuietly(connection);
      };
      const bootstrapAbort = new AbortController();
      pendingConnection = { close: closeConnection, abort: () => bootstrapAbort.abort() };
      const transport = createAuthenticatedHostChatRecoveryTransport(connection.request);
      let scope: MessageRecoveryScope;
      try {
        scope = await transport.readScope(bootstrapAbort.signal);
      } catch {
        if (pendingConnection?.close === closeConnection) pendingConnection = undefined;
        await closeConnection();
        return;
      }
      if (disposed || token !== activation) {
        if (pendingConnection?.close === closeConnection) pendingConnection = undefined;
        await closeConnection();
        return;
      }
      if (pendingConnection?.close === closeConnection) pendingConnection = undefined;
      const controller = createMessageRecoveryController({
        scope,
        store,
        transport,
        createRequestId: randomUUID,
        classifyTransportFailure: classifyAuthenticatedHostChatRecoveryTransportFailure,
      });
      let timeoutId = 0;
      const timeoutHandles = new Map<number, ReturnType<typeof setTimeout>>();
      const scheduler = createMessageRecoveryScheduler(controller, {
        runtime: {
          now: Date.now,
          setTimeout: (callback, delay) => {
            const id = ++timeoutId;
            const timeout = setTimeout(() => {
              timeoutHandles.delete(id);
              callback();
            }, delay);
            timeoutHandles.set(id, timeout);
            return id;
          },
          clearTimeout: (handle) => {
            if (typeof handle !== "number") return;
            const timeout = timeoutHandles.get(handle);
            if (timeout !== undefined) clearTimeout(timeout);
            timeoutHandles.delete(handle);
          },
          jitter: (base) => (base === 0 ? 0 : Math.round(base * (0.9 + Math.random() * 0.2))),
        },
        classifyFailure: classifyAuthenticatedHostChatRecoveryTransportFailure,
        onState: (recovery) => {
          if (disposed || token !== activation || active?.token !== token) return;
          if (recovery.phase === "stopped" && recovery.reason !== "stopped") {
            const failed = active;
            active = undefined;
            activation += 1;
            failed.scheduler.logout();
            publish({ status: "not-connected" });
            void failed.close();
            return;
          }
          publish({ status: "ready", phase: recovery.phase });
        },
      });
      active = { token, controller, scheduler, close: closeConnection };
      scheduler.start();
    },
    sendChat: (target, content) => {
      if (!active) return Promise.reject(new Error("Host is not connected."));
      return active.controller.sendChat(target, content);
    },
    recover: async () => {
      const current = active;
      if (!current) return;
      current.scheduler.resume();
      try {
        await current.controller.flushOutbox();
        await current.controller.recover();
      } catch (error) {
        const permanent =
          (error instanceof MessageRecoveryError && error.code === "transport-permanent") ||
          classifyAuthenticatedHostChatRecoveryTransportFailure(error) === "permanent";
        if (permanent && active?.token === current.token) {
          active = undefined;
          activation += 1;
          current.scheduler.logout();
          publish({ status: "not-connected" });
          await current.close();
        }
        throw error;
      }
    },
    dispose: () => {
      if (disposeFlight) return disposeFlight;
      disposed = true;
      disposeFlight = (async () => {
        await deactivate();
        store.close();
        publish({ status: "not-connected" });
      })();
      return disposeFlight;
    },
  };
}
