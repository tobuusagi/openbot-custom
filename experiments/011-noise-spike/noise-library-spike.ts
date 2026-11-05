import { noise } from "@chainsafe/libp2p-noise";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type {
  ComponentLogger,
  ConnectionEncrypter,
  Logger,
  MessageStream,
  MessageStreamEvents,
  PeerId,
  PrivateKey,
  StreamMuxerFactory,
  Upgrader,
} from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { AbstractMessageStream } from "@libp2p/utils";

const deadlineMs = 4_000;
const expectedPeerError = "does not match expected remote identity key";

export interface NoiseSpikeCheck {
  name: string;
  passed: boolean;
  error?: string;
}

interface NoiseSpikeRejection {
  name: string;
  message: string;
  isError: boolean;
}

export interface NoiseSpikeReport {
  runtime: string;
  protocol: "Noise_XX_25519_ChaChaPoly_SHA256";
  library: "@chainsafe/libp2p-noise@17.0.0";
  status: "passed" | "failed";
  checks: NoiseSpikeCheck[];
  checkCounts: { total: number; passed: number; failed: number };
  limits: string[];
}

type WireHook = (bytes: Uint8Array, deliver: (nextBytes: Uint8Array) => void) => void;

const quietLogger = createQuietLogger();

function createQuietLogger(): Logger {
  const logger = Object.assign(() => undefined, {
    error: () => undefined,
    trace: () => undefined,
    enabled: false,
    newScope: (_name: string): Logger => createQuietLogger(),
  }) satisfies Logger;

  return logger;
}

class MemoryMessageStream extends AbstractMessageStream {
  remote?: MemoryMessageStream;
  wireHook?: WireHook;

  constructor() {
    super({ log: quietLogger, direction: "outbound", inactivityTimeout: deadlineMs });
  }

  sendData(data: Parameters<AbstractMessageStream["sendData"]>[0]) {
    const bytes = data.slice();
    const deliver = (nextBytes: Uint8Array) => {
      this.remote?.push(nextBytes.slice());
    };

    if (this.wireHook == null) {
      deliver(bytes);
    } else {
      this.wireHook(bytes, deliver);
    }

    return { sentBytes: data.byteLength, canSendMore: true };
  }

  sendReset(_error: Error): void {
    this.remote?.onRemoteReset();
  }

  sendPause(): void {}

  sendResume(): void {}

  async close(): Promise<void> {
    if (this.writeStatus !== "writable") {
      return;
    }

    this.writeStatus = "closed";
    this.remote?.onRemoteCloseWrite();

    if (this.remoteWriteStatus === "closed") {
      this.onTransportClosed();
    }
  }
}

interface MemoryStreamPair {
  left: MemoryMessageStream;
  right: MemoryMessageStream;
}

function createMemoryStreamPair(): MemoryStreamPair {
  const left = new MemoryMessageStream();
  const right = new MemoryMessageStream();
  left.remote = right;
  right.remote = left;
  return { left, right };
}

function createNoiseEncrypter(privateKey: PrivateKey) {
  const peerId = peerIdFromPrivateKey(privateKey);
  const componentLogger: ComponentLogger = { forComponent: () => quietLogger };
  const upgrader = createUnusedUpgrader();

  return noise()({ peerId, privateKey, logger: componentLogger, upgrader });
}

function createUnusedUpgrader(): Upgrader {
  const unsupported = async (): Promise<never> => {
    throw new Error("The isolated Noise spike does not use libp2p upgrade methods");
  };

  return {
    upgradeOutbound: unsupported,
    upgradeInbound: async () => undefined,
    createInboundAbortSignal: (signal) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      return Object.assign(controller.signal, {
        clear: () => signal.removeEventListener("abort", onAbort),
      });
    },
    getStreamMuxers: (): Map<string, StreamMuxerFactory> => new Map(),
    getConnectionEncrypters: (): Map<string, ConnectionEncrypter> => new Map(),
  };
}

function addCheck(checks: NoiseSpikeCheck[], name: string, passed: boolean): void {
  checks.push({ name, passed });
  if (!passed) {
    throw new Error(`Assertion failed: ${name}`);
  }
}

function recordScenarioError(checks: NoiseSpikeCheck[], name: string, error: unknown): void {
  checks.push({ name, passed: false, error: errorName(error) });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function rejectionDetails(reason: unknown): NoiseSpikeRejection {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, isError: true };
  }
  return { name: "UnknownError", message: "", isError: false };
}

async function withDeadline<T>(promise: Promise<T>, name: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Deadline exceeded: ${name}`)), deadlineMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function expectRejection(promise: Promise<unknown>, name: string): Promise<NoiseSpikeRejection> {
  return await withDeadline(
    promise.then(
      () => {
        throw new Error(`${name} unexpectedly resolved`);
      },
      (error: unknown) => rejectionDetails(error),
    ),
    name,
  );
}

function bytesFrom(data: MessageStreamEvents["message"]["data"]): Uint8Array {
  return data.slice();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  return left.every((byte, index) => byte === right[index]);
}

function waitForMessage(stream: MessageStream): Promise<Uint8Array> {
  return withDeadline(
    new Promise<Uint8Array>((resolve, reject) => {
      const cleanup = () => {
        stream.removeEventListener("message", onMessage);
        stream.removeEventListener("close", onClose);
      };
      const onMessage = (event: MessageStreamEvents["message"]) => {
        cleanup();
        resolve(bytesFrom(event.data));
      };
      const onClose = (event: MessageStreamEvents["close"]) => {
        cleanup();
        reject(event.error ?? new Error("Stream closed before a message arrived"));
      };

      stream.addEventListener("message", onMessage);
      stream.addEventListener("close", onClose);
    }),
    "encrypted payload delivery",
  );
}

function waitForCloseError(stream: MessageStream): Promise<Error> {
  return withDeadline(
    new Promise<Error>((resolve, reject) => {
      const onClose = (event: MessageStreamEvents["close"]) => {
        stream.removeEventListener("close", onClose);
        if (event.error == null) {
          reject(new Error("Stream closed without a decryption error"));
        } else {
          resolve(event.error);
        }
      };

      stream.addEventListener("close", onClose);
    }),
    "authenticated decryption failure",
  );
}

function cleanupPair(pair: MemoryStreamPair): void {
  const reason = new Error("Noise spike cleanup");
  pair.left.abort(reason);
  pair.right.abort(reason);
}

async function createIdentity() {
  const privateKey = await withDeadline(generateKeyPair("Ed25519"), "generated test identity");
  return { privateKey, peerId: peerIdFromPrivateKey(privateKey) };
}

type NoiseEncrypter = ReturnType<typeof createNoiseEncrypter>;

interface ConnectedPair {
  transport: MemoryStreamPair;
  initiator: Awaited<ReturnType<NoiseEncrypter["secureOutbound"]>>;
  responder: Awaited<ReturnType<NoiseEncrypter["secureInbound"]>>;
}

async function connectPair(
  initiatorKey: PrivateKey,
  responderKey: PrivateKey,
  expectedInitiatorPeer: PeerId,
  expectedResponderPeer: PeerId,
): Promise<ConnectedPair> {
  const transport = createMemoryStreamPair();
  const initiator = createNoiseEncrypter(initiatorKey);
  const responder = createNoiseEncrypter(responderKey);
  const options = { skipStreamMuxerNegotiation: true };
  const outboundPromise = initiator.secureOutbound(transport.left, {
    ...options,
    remotePeer: expectedInitiatorPeer,
  });
  const inboundPromise = responder.secureInbound(transport.right, {
    ...options,
    remotePeer: expectedResponderPeer,
  });

  try {
    const [securedInitiator, securedResponder] = await withDeadline(
      Promise.all([outboundPromise, inboundPromise]),
      "mutual Noise XX handshake",
    );
    return { transport, initiator: securedInitiator, responder: securedResponder };
  } catch (error) {
    cleanupPair(transport);
    await withDeadline(Promise.allSettled([outboundPromise, inboundPromise]), "failed handshake cleanup");
    throw error;
  }
}

async function runIdentityAndPayloadScenario(checks: NoiseSpikeCheck[]): Promise<void> {
  let transport: MemoryStreamPair | undefined;

  try {
    const [initiatorIdentity, responderIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    const connected = await connectPair(
      initiatorIdentity.privateKey,
      responderIdentity.privateKey,
      responderIdentity.peerId,
      initiatorIdentity.peerId,
    );
    transport = connected.transport;

    addCheck(
      checks,
      "XX handshake reports the expected remote peer identities at both ends",
      connected.initiator.remotePeer.equals(responderIdentity.peerId) &&
        connected.responder.remotePeer.equals(initiatorIdentity.peerId),
    );

    const outboundPayload = new TextEncoder().encode("client-to-host test payload");
    const inboundPayload = waitForMessage(connected.responder.connection);
    addCheck(
      checks,
      "initiator accepts the outbound payload write",
      connected.initiator.connection.send(outboundPayload),
    );
    addCheck(
      checks,
      "responder decrypts the outbound payload bytes",
      equalBytes(await inboundPayload, outboundPayload),
    );

    const responderPayload = new TextEncoder().encode("host-to-client test payload");
    const returnedPayload = waitForMessage(connected.initiator.connection);
    addCheck(
      checks,
      "responder accepts the return payload write",
      connected.responder.connection.send(responderPayload),
    );
    addCheck(
      checks,
      "initiator decrypts the return payload bytes",
      equalBytes(await returnedPayload, responderPayload),
    );
  } catch (error) {
    recordScenarioError(checks, "mutual XX handshake and bidirectional payload scenario", error);
  } finally {
    if (transport != null) {
      cleanupPair(transport);
    }
  }
}

async function runWrongIdentityScenario(checks: NoiseSpikeCheck[]): Promise<void> {
  const transport = createMemoryStreamPair();
  const clientController = new AbortController();
  const hostController = new AbortController();

  try {
    const [clientIdentity, hostIdentity, wrongIdentity] = await Promise.all([
      createIdentity(),
      createIdentity(),
      createIdentity(),
    ]);
    const options = { skipStreamMuxerNegotiation: true };
    const clientPromise = createNoiseEncrypter(clientIdentity.privateKey).secureOutbound(transport.left, {
      ...options,
      remotePeer: wrongIdentity.peerId,
      signal: clientController.signal,
    });
    const hostPromise = createNoiseEncrypter(hostIdentity.privateKey).secureInbound(transport.right, {
      ...options,
      remotePeer: clientIdentity.peerId,
      signal: hostController.signal,
    });
    const rejection = await expectRejection(clientPromise, "wrong expected remote identity");

    addCheck(
      checks,
      "expected remote identity mismatch rejects the XX handshake",
      rejection.name === "UnexpectedPeerError" && rejection.message.includes(expectedPeerError),
    );

    clientController.abort();
    hostController.abort();
    const hostRejection = await expectRejection(hostPromise, "wrong identity peer cleanup");
    addCheck(checks, "the peer waiting for the final XX message settles after cancellation", hostRejection.isError);
  } catch (error) {
    recordScenarioError(checks, "wrong identity rejection scenario", error);
  } finally {
    clientController.abort();
    hostController.abort();
    cleanupPair(transport);
  }
}

async function runTamperScenario(checks: NoiseSpikeCheck[]): Promise<void> {
  let transport: MemoryStreamPair | undefined;

  try {
    const [clientIdentity, hostIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    const connected = await connectPair(
      clientIdentity.privateKey,
      hostIdentity.privateKey,
      hostIdentity.peerId,
      clientIdentity.peerId,
    );
    transport = connected.transport;
    let changedCiphertext = false;
    transport.left.wireHook = (bytes, deliver) => {
      if (!changedCiphertext) {
        const lastIndex = bytes.byteLength - 1;
        const lastByte = bytes[lastIndex];
        if (lastByte == null) {
          throw new Error("Cannot tamper with an empty ciphertext record");
        }
        bytes[lastIndex] = lastByte ^ 1;
        changedCiphertext = true;
      }
      deliver(bytes);
    };

    const closeError = waitForCloseError(connected.responder.connection);
    connected.initiator.connection.send(new TextEncoder().encode("tamper test payload"));
    await closeError;
    addCheck(
      checks,
      "tampered ciphertext causes authenticated decryption to close the receiving stream",
      changedCiphertext,
    );
  } catch (error) {
    recordScenarioError(checks, "tampered ciphertext rejection scenario", error);
  } finally {
    if (transport != null) {
      cleanupPair(transport);
    }
  }
}

async function runReplayScenario(checks: NoiseSpikeCheck[]): Promise<void> {
  let transport: MemoryStreamPair | undefined;

  try {
    const [clientIdentity, hostIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    const connected = await connectPair(
      clientIdentity.privateKey,
      hostIdentity.privateKey,
      hostIdentity.peerId,
      clientIdentity.peerId,
    );
    transport = connected.transport;
    let recordedCiphertext: Uint8Array | undefined;
    let replayPriorCiphertext = false;

    transport.left.wireHook = (bytes, deliver) => {
      if (recordedCiphertext == null) {
        recordedCiphertext = bytes.slice();
        deliver(bytes);
        return;
      }

      if (replayPriorCiphertext) {
        replayPriorCiphertext = false;
        deliver(recordedCiphertext.slice());
        return;
      }

      deliver(bytes);
    };

    const firstPlaintext = new TextEncoder().encode("first replay test payload");
    const firstMessage = waitForMessage(connected.responder.connection);
    connected.initiator.connection.send(firstPlaintext);
    addCheck(
      checks,
      "receiver accepts the first valid ciphertext at its initial sequence position",
      equalBytes(await firstMessage, firstPlaintext),
    );

    replayPriorCiphertext = true;
    const closeError = waitForCloseError(connected.responder.connection);
    connected.initiator.connection.send(new TextEncoder().encode("second replay test payload"));
    await closeError;
    addCheck(
      checks,
      "receiver rejects a replayed prior ciphertext at the next sequence position",
      recordedCiphertext != null,
    );
  } catch (error) {
    recordScenarioError(checks, "replay rejection scenario", error);
  } finally {
    if (transport != null) {
      cleanupPair(transport);
    }
  }
}

async function runCancellationScenario(checks: NoiseSpikeCheck[]): Promise<void> {
  const transport = createMemoryStreamPair();
  const { left: client, right: unusedRemote } = transport;
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;

  try {
    const [clientIdentity, hostIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    pending = createNoiseEncrypter(clientIdentity.privateKey).secureOutbound(client, {
      remotePeer: hostIdentity.peerId,
      signal: controller.signal,
      skipStreamMuxerNegotiation: true,
    });
    controller.abort();
    const rejection = await expectRejection(pending, "cancelled Noise handshake");
    addCheck(
      checks,
      "AbortSignal cancels an incomplete Noise handshake within the deadline",
      rejection.name === "AbortError",
    );
  } catch (error) {
    recordScenarioError(checks, "handshake cancellation scenario", error);
  } finally {
    controller.abort();
    client.abort(new Error("Noise spike cancellation cleanup"));
    unusedRemote.abort(new Error("Noise spike cancellation cleanup"));
    checks.push({
      name: "cancelled transport pair closes both in-memory endpoints",
      passed:
        ["aborted", "reset", "closed"].includes(client.status) &&
        ["aborted", "reset", "closed"].includes(unusedRemote.status),
    });
    if (pending != null) {
      try {
        await withDeadline(Promise.allSettled([pending]), "cancelled handshake cleanup");
      } catch (error) {
        recordScenarioError(checks, "cancelled handshake releases pending work", error);
      }
    }
  }
}

export async function runNoiseLibrarySpike(runtime: string): Promise<NoiseSpikeReport> {
  const checks: NoiseSpikeCheck[] = [];

  await runIdentityAndPayloadScenario(checks);
  await runWrongIdentityScenario(checks);
  await runTamperScenario(checks);
  await runReplayScenario(checks);
  await runCancellationScenario(checks);

  const passed = checks.filter((check) => check.passed).length;
  const failed = checks.length - passed;

  return {
    runtime,
    protocol: "Noise_XX_25519_ChaChaPoly_SHA256",
    library: "@chainsafe/libp2p-noise@17.0.0",
    status: failed === 0 ? "passed" : "failed",
    checks,
    checkCounts: { total: checks.length, passed, failed },
    limits: [
      "Memory duplex transport only; no WebSocket adapter or product protocol was tested.",
      "Generated Ed25519 identities and ephemeral Noise keys exist only in memory for this run.",
      "Physical Electron macOS ARM64, Electron Windows ARM64, and Android WebView were not tested.",
      "A passing spike is feasibility evidence only; it does not approve production WSS or key management.",
    ],
  };
}
