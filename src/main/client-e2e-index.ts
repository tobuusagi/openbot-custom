import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { app } from "electron";
import { startClientRuntime } from "./client-runtime";

const apiOrigin = requireLoopbackApiOrigin(process.env.CLIENT_E2E_API_ORIGIN);
const userDataPath = requireAbsolutePath(process.env.CLIENT_E2E_USER_DATA, "CLIENT_E2E_USER_DATA");
const storageKey = requireStorageKey(process.env.CLIENT_E2E_STORAGE_KEY);
const debuggingPort = requirePort(process.env.CLIENT_E2E_DEBUGGING_PORT);
let startupStage = "environment-validated";

type ClientE2EDiagnostic =
  | { type: "stage"; stage: string }
  | {
      type: "startup-error";
      stage: string;
      errorName: string;
      errorCode: number | string | null;
      message: string;
    }
  | {
      type: "did-fail-load";
      stage: string;
      errorCode: number;
      errorDescription: string;
      validatedUrl: string;
      isMainFrame: boolean;
    }
  | { type: "render-process-gone"; stage: string; reason: string; exitCode: number }
  | { type: "preload-error"; stage: string; preloadPath: string; errorName: string; message: string };

function emitDiagnostic(diagnostic: ClientE2EDiagnostic): void {
  process.stderr.write(`[client-runtime-e2e-diagnostic] ${JSON.stringify(diagnostic)}\n`);
}

function setStartupStage(stage: string): void {
  startupStage = stage;
  emitDiagnostic({ type: "stage", stage });
}

app.setName("FeituOpenBotClientE2E");
app.setPath("userData", userDataPath);
app.enableSandbox();
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(debuggingPort));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(() => {
      setStartupStage("electron-ready");
      return startClientRuntime({
        apiOrigin,
        userDataPath,
        rendererRoot: resolve(__dirname, "../renderer"),
        preloadPath: resolve(__dirname, "../preload/client-index.cjs"),
        secureStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => encrypt(storageKey, value),
          decryptString: (value) => decrypt(storageKey, value),
        },
        onStartupStage: setStartupStage,
        onWindowCreated: (window) => {
          window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
            emitDiagnostic({
              type: "did-fail-load",
              stage: startupStage,
              errorCode,
              errorDescription,
              validatedUrl,
              isMainFrame,
            });
          });
          window.webContents.on("render-process-gone", (_event, details) => {
            emitDiagnostic({
              type: "render-process-gone",
              stage: startupStage,
              reason: details.reason,
              exitCode: details.exitCode,
            });
          });
          window.webContents.on("preload-error", (_event, preloadPath, error) => {
            emitDiagnostic({
              type: "preload-error",
              stage: startupStage,
              preloadPath,
              errorName: error.name,
              message: error.message,
            });
          });
        },
      });
    })
    .catch((error: unknown) => {
      emitDiagnostic({
        type: "startup-error",
        stage: startupStage,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
      app.exit(1);
    });
}

function errorCode(error: unknown): number | string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "number" || typeof code === "string" ? code : null;
}

function requireLoopbackApiOrigin(value: string | undefined): string {
  if (!value) throw new Error("The client runtime E2E API origin is missing.");
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("The client runtime E2E API origin must be a loopback HTTP origin.");
  }
  return origin.origin;
}

function requireAbsolutePath(value: string | undefined, variableName: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${variableName} must be an absolute path.`);
  return resolve(value);
}

function requireStorageKey(value: string | undefined): Buffer {
  if (!value || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw new Error("The client runtime E2E storage key must be 32 bytes encoded as hex.");
  }
  return Buffer.from(value, "hex");
}

function requirePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The client runtime E2E debugging port is invalid.");
  }
  return port;
}

function encrypt(key: Buffer, value: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(key: Buffer, encrypted: Buffer): string {
  if (encrypted.length < 28) throw new Error("The E2E encrypted session is truncated.");
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(12, 28);
  const ciphertext = encrypted.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
