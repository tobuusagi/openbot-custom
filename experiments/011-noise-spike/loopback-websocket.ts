import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type {
  ComponentLogger,
  Logger,
  MessageStream,
  MessageStreamEvents,
  PrivateKey,
  StreamMuxerFactory,
  Upgrader,
} from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { AbstractMessageStream } from "@libp2p/utils";
import { WebSocket, WebSocketServer } from "ws";

const deadlineMs = 4_000;
const quietLogger: Logger = Object.assign(() => undefined, {
  error: () => undefined,
  trace: () => undefined,
  enabled: false,
  newScope: (_name: string): Logger => quietLogger,
});

class WsMessageStream extends AbstractMessageStream {
  readonly socket: WebSocket;
  captured?: Uint8Array;
  captureNext = false;
  tamperNext = false;

  constructor(socket: WebSocket) {
    super({ log: quietLogger, direction: "outbound", inactivityTimeout: deadlineMs });
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.abort(new Error("Unexpected text frame"));
        return;
      }
      if (Buffer.isBuffer(data)) {
        this.push(new Uint8Array(data));
      } else if (data instanceof ArrayBuffer) {
        this.push(new Uint8Array(data));
      } else {
        this.push(new Uint8Array(Buffer.concat(data)));
      }
    });
    socket.on("close", () => {
      this.onRemoteCloseWrite();
      if (this.remoteWriteStatus === "closed") this.onTransportClosed();
    });
    socket.on("error", (error) => this.abort(error));
  }

  sendData(data: Parameters<AbstractMessageStream["sendData"]>[0]) {
    const bytes = data.slice();
    if (this.captureNext) {
      this.captured = bytes.slice();
      this.captureNext = false;
    }
    if (this.tamperNext) {
      this.tamperNext = false;
      const index = bytes.byteLength - 1;
      if (index >= 0) bytes[index] = (bytes[index] ?? 0) ^ 1;
    }
    this.socket.send(bytes, { binary: true });
    return { sentBytes: data.byteLength, canSendMore: true };
  }
  sendReset(_error: Error): void {
    this.socket.terminate();
  }
  sendPause(): void {}
  sendResume(): void {}
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

function unusedUpgrader(): Upgrader {
  const unsupported = async (): Promise<never> => {
    throw new Error("No libp2p upgrades in this experiment");
  };
  return {
    upgradeOutbound: unsupported,
    upgradeInbound: async () => undefined,
    createInboundAbortSignal: (signal) => Object.assign(signal, { clear: () => undefined }),
    getStreamMuxers: (): Map<string, StreamMuxerFactory> => new Map(),
    getConnectionEncrypters: () => new Map(),
  };
}

function encrypter(key: PrivateKey) {
  const componentLogger: ComponentLogger = { forComponent: () => quietLogger };
  return noise()({
    peerId: peerIdFromPrivateKey(key),
    privateKey: key,
    logger: componentLogger,
    upgrader: unusedUpgrader(),
  });
}

async function identity() {
  const privateKey = await generateKeyPair("Ed25519");
  return { privateKey, peerId: peerIdFromPrivateKey(privateKey) };
}

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function message(stream: MessageStream): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Deadline: encrypted message"));
    }, deadlineMs);
    const data = (event: MessageStreamEvents["message"]) => {
      cleanup();
      resolve(event.data.slice());
    };
    const closed = (event: MessageStreamEvents["close"]) => {
      cleanup();
      reject(event.error ?? new Error("stream closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeEventListener("message", data);
      stream.removeEventListener("close", closed);
    };
    stream.addEventListener("message", data);
    stream.addEventListener("close", closed);
  });
}

async function main() {
  const checks: { name: string; passed: boolean; error?: string }[] = [];
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) throw new Error(name);
  };
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Loopback server did not bind TCP port");
  const connect = async () => {
    let hostSocket: WebSocket | undefined;
    const hostSocketPromise = deadline(
      new Promise<WebSocket>((resolve) => {
        wss.once("connection", (socket) => resolve(socket));
      }),
      "host WebSocket accept",
    );
    const clientSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    try {
      await deadline(
        once(clientSocket, "open").then(() => undefined),
        "client WebSocket open",
      );
      hostSocket = await hostSocketPromise;
      return { client: new WsMessageStream(clientSocket), host: new WsMessageStream(hostSocket) };
    } catch (error) {
      clientSocket.terminate();
      hostSocket?.terminate();
      throw error;
    }
  };
  const keys = await Promise.all([identity(), identity()]);
  const [clientIdentity, hostIdentity] = keys;
  const pair = async () => {
    const transport = await connect();
    try {
      const [client, host] = await deadline(
        Promise.all([
          encrypter(clientIdentity.privateKey).secureOutbound(transport.client, {
            remotePeer: hostIdentity.peerId,
            skipStreamMuxerNegotiation: true,
          }),
          encrypter(hostIdentity.privateKey).secureInbound(transport.host, {
            remotePeer: clientIdentity.peerId,
            skipStreamMuxerNegotiation: true,
          }),
        ]),
        "mutual Noise XX handshake",
      );
      return { transport, client, host };
    } catch (error) {
      transport.client.socket.terminate();
      transport.host.socket.terminate();
      throw error;
    }
  };
  try {
    let first = await pair();
    check(
      "Noise XX completes over a real 127.0.0.1 WebSocket/TCP connection",
      first.client.remotePeer.equals(hostIdentity.peerId) && first.host.remotePeer.equals(clientIdentity.peerId),
    );
    const payload = new TextEncoder().encode("loopback encrypted payload");
    const delivered = message(first.host.connection);
    first.transport.client.captureNext = true;
    first.client.connection.send(payload);
    check(
      "client-to-host Noise data is decrypted over WebSocket binary frames",
      Buffer.from(await delivered).equals(Buffer.from(payload)),
    );
    const response = new TextEncoder().encode("host response");
    const returned = message(first.client.connection);
    first.host.connection.send(response);
    check(
      "host-to-client Noise data is decrypted over the same WebSocket",
      Buffer.from(await returned).equals(Buffer.from(response)),
    );
    const oldFrame = first.transport.client.captured;
    first.transport.client.socket.terminate();
    first.transport.host.socket.terminate();
    first = await pair();
    check(
      "disconnect followed by a new WebSocket establishes a fresh Noise session",
      first.client.remotePeer.equals(hostIdentity.peerId),
    );
    if (oldFrame == null) throw new Error("No old session frame was captured");
    const oldRejected = deadline(
      new Promise<boolean>((resolve) => {
        first.transport.host.addEventListener("close", (event) => resolve(event.error != null), { once: true });
        first.transport.client.socket.send(oldFrame.slice(), { binary: true });
      }),
      "old-session ciphertext rejection",
    );
    check("ciphertext from the prior session is rejected by the new session", await oldRejected);
    first.transport.client.socket.terminate();
    first.transport.host.socket.terminate();

    const transport = await connect();
    const wrong = await identity();
    const pending = encrypter(clientIdentity.privateKey).secureOutbound(transport.client, {
      remotePeer: wrong.peerId,
      skipStreamMuxerNegotiation: true,
    });
    const inbound = encrypter(hostIdentity.privateKey).secureInbound(transport.host, {
      remotePeer: clientIdentity.peerId,
      skipStreamMuxerNegotiation: true,
    });
    let identityRejected = false;
    try {
      await deadline(pending, "wrong identity");
    } catch (error) {
      identityRejected = error instanceof Error && error.name === "UnexpectedPeerError";
    }
    check("wrong expected remote identity is rejected", identityRejected);
    transport.client.socket.terminate();
    transport.host.socket.terminate();
    await Promise.allSettled([inbound]);

    const altered = await pair();
    altered.transport.client.tamperNext = true;
    const tamperedRejected = deadline(
      new Promise<boolean>((resolve) => {
        altered.transport.host.addEventListener("close", (event) => resolve(event.error != null), { once: true });
        altered.client.connection.send(new TextEncoder().encode("tamper"));
      }),
      "tamper rejection",
    );
    check("tampered ciphertext fails authenticated decryption", await tamperedRejected);
    altered.transport.client.socket.terminate();
    altered.transport.host.socket.terminate();
  } catch (error) {
    checks.push({
      name: "loopback WebSocket Noise scenario",
      passed: false,
      error: error instanceof Error ? error.message : "UnknownError",
    });
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => wss.close((error) => (error == null ? resolve() : reject(error))));
    await new Promise<void>((resolve, reject) => server.close((error) => (error == null ? resolve() : reject(error))));
  }
  const passed = checks.filter((entry) => entry.passed).length;
  const report = {
    runtime: `Node ${process.version}`,
    transport: "loopback WebSocket over 127.0.0.1 TCP; no TLS",
    protocol: "Noise_XX_25519_ChaChaPoly_SHA256",
    checks,
    checkCounts: { total: checks.length, passed, failed: checks.length - passed },
    status: passed === checks.length ? "passed" : "failed",
    limits: [
      "Private experiment only; no product WSS, gateway, public relay, grants, persistence, or application receipts.",
      "Reconnect proves a fresh cryptographic session only; it does not implement message replay, idempotency, or offline recovery.",
      "Generated test identities and keys remain in process memory.",
      "Physical Electron macOS ARM64, Windows ARM64, and Android WebView are untested.",
    ],
  };
  const outputPath = path.resolve(
    import.meta.dirname,
    "../../.openbot-build/011-noise-spike/loopback-websocket-report.json",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: outputPath }, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

void main();
