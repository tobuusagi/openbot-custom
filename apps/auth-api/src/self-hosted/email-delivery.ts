import { connect as connectTls } from "node:tls";
import { type SmtpConnector, sendPrivateEmailCode } from "../server/smtp-email-delivery";
import type { EmailCodeDelivery } from "../server/types";
import type { SelfHostedSmtpConfig } from "./config";

/** Creates the local SMTP adapter. It always uses verified implicit TLS and never loads Worker sockets. */
export function createSelfHostedEmailCodeDelivery(config: SelfHostedSmtpConfig): EmailCodeDelivery {
  if ("relay" in config) throw new Error("Self-hosted SMTP cannot use a Worker email relay.");
  const connector = createSelfHostedSmtpConnector();
  return { send: (message) => sendPrivateEmailCode(config, message, connector) };
}

/** The connector is exported so the local E2E can exercise the Node TLS adapter with a test CA. */
export function createSelfHostedSmtpConnector(): SmtpConnector {
  return (address, options) => {
    if (options.secureTransport !== "on" || options.allowHalfOpen !== false) {
      throw new Error("The self-hosted SMTP adapter requires implicit TLS.");
    }
    const socket = connectTls({
      host: address.hostname,
      port: address.port,
      servername: address.hostname,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      allowHalfOpen: false,
    });
    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.off("secureConnect", onSecureConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (cause: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      };
      const onSecureConnect = () => {
        succeed();
      };
      const onError = (cause: Error) => {
        fail(cause);
      };
      const onClose = () => fail(new Error("smtp_connection_closed"));
      socket.once("secureConnect", onSecureConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    let removeReadableListeners = () => {};
    const readable = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const onData = (chunk: Uint8Array) => {
            try {
              controller.enqueue(chunk);
              if (controller.desiredSize !== null && controller.desiredSize <= 0) socket.pause();
            } catch (cause) {
              removeReadableListeners();
              socket.destroy(cause instanceof Error ? cause : undefined);
            }
          };
          const onEnd = () => {
            removeReadableListeners();
            controller.close();
          };
          const onError = (cause: Error) => {
            removeReadableListeners();
            controller.error(cause);
          };
          const onClose = () => {
            removeReadableListeners();
            controller.close();
          };
          removeReadableListeners = () => {
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
            socket.off("close", onClose);
          };
          socket.on("data", onData);
          socket.once("end", onEnd);
          socket.once("error", onError);
          socket.once("close", onClose);
        },
        pull() {
          socket.resume();
        },
        cancel(reason) {
          removeReadableListeners();
          socket.destroy(reason instanceof Error ? reason : undefined);
        },
      },
      { highWaterMark: 1 },
    );
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          socket.write(chunk, (cause?: Error | null) => {
            if (cause) reject(cause);
            else resolve();
          });
        });
      },
      close() {
        return new Promise<void>((resolve, reject) => {
          const onFinish = () => {
            socket.off("error", onError);
            resolve();
          };
          const onError = (cause: Error) => {
            socket.off("finish", onFinish);
            reject(cause);
          };
          socket.once("finish", onFinish);
          socket.once("error", onError);
          socket.end();
        });
      },
      abort(reason) {
        removeReadableListeners();
        socket.destroy(reason instanceof Error ? reason : undefined);
      },
    });
    return {
      readable,
      writable,
      opened,
      close: () => {
        removeReadableListeners();
        socket.destroy();
      },
    };
  };
}
