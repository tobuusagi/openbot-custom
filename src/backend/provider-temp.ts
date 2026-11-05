import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { causeHelpers } from "./effect-boundary";

const logger = createOpenBotLogger("provider-temp");

/**
 * The free space a provider process needs in its temporary folder. The Windows Antigravity server
 * is a PyInstaller one-file program: each start unpacks about 310 MB into `%TEMP%\_MEI<hex>`.
 */
const PROVIDER_TEMP_FREE_BYTES = 1024 ** 3;
const ownedCleanup = new WeakMap<ChildProcess, Promise<void>>();

export interface ProviderTempOptions {
  /** A folder OpenBot owns. Each process gets a new folder in it, removed when the process ends. */
  root: string;
  provider: string;
  availableDiskBytes?: ((path: string) => number) | undefined;
}

/** The disk has too little free space for the process to unpack. No process started. */
export class ProviderTempDiskSpaceError extends Error {}

/** A private provider temp folder could not be removed after its process ended. */
export class ProviderTempCleanupError extends Error {
  constructor(provider: string) {
    super(sourceText("error.provider.tempCleanupFailed", { provider }));
    this.name = "ProviderTempCleanupError";
  }
}

/** A temporary folder that could not be listed or removed. Only the log sees it. */
class ProviderTempIoError extends Schema.TaggedError<ProviderTempIoError>()("ProviderTempIoError", {
  cause: Schema.Defect(),
}) {}

const { io } = causeHelpers(ProviderTempIoError);

/**
 * Starts a provider process with a temporary folder of its own. Only the program's own launcher
 * removes what it unpacked, and only when it ends normally: a process that is stopped or that times
 * out left each unpacked copy in the system temporary folder. OpenBot removes this folder after the
 * process closes, and what is left in the root at launch (`sweepProviderTemp`).
 */
export function spawnWithProviderTemp<Child extends ChildProcess>(
  options: ProviderTempOptions | undefined,
  start: (env: Record<string, string>) => Child,
): Child {
  if (!options) return start({});
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const available = (options.availableDiskBytes ?? freeDiskBytes)(options.root);
  if (available < PROVIDER_TEMP_FREE_BYTES)
    throw new ProviderTempDiskSpaceError(sourceText("error.provider.tempDiskSpace", { provider: options.provider }));
  const directory = mkdtempSync(join(options.root, "run-"));
  let child: Child;
  try {
    // `TMP` and `TEMP` on Windows, `TMPDIR` elsewhere.
    child = start({ TMP: directory, TEMP: directory, TMPDIR: directory });
  } catch (error) {
    // There is no child to wait for when `spawn` itself throws, so finish removal synchronously.
    // A failed removal must not let the next process start over a stale Antigravity unpack.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      logger.warn("A provider temporary folder was not removed.", { provider: options.provider });
      throw new ProviderTempCleanupError(options.provider);
    }
    throw error;
  }
  let resolveCleanup!: () => void;
  let rejectCleanup!: (error: ProviderTempCleanupError) => void;
  const cleanup = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  // The process can close before its owner calls stop. Mark the rejection handled now, while
  // keeping the original promise available to `waitForProviderTempCleanup`.
  void cleanup.catch(() => undefined);
  ownedCleanup.set(child, cleanup);
  let cleanupStarted = false;
  const dispose = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    Effect.runPromise(removeDirectory(directory, options.provider)).then(resolveCleanup, rejectCleanup);
  };
  child.once("close", dispose);
  // A process that never started has no `close` to wait for.
  child.once("error", () => {
    if (child.pid === undefined) dispose();
  });
  return child;
}

/** Waits for the process-owned folder to be removed, if this child had one. */
export function waitForProviderTempCleanup(child: ChildProcess): Effect.Effect<void, ProviderTempCleanupError> {
  const cleanup = ownedCleanup.get(child);
  if (!cleanup) return Effect.void;
  return Effect.tryPromise({
    try: () => cleanup,
    catch: (error) => (error instanceof ProviderTempCleanupError ? error : new ProviderTempCleanupError("provider")),
  });
}

/**
 * Removes the folders that processes of an earlier run left in the root. It lists them before any
 * provider starts and removes them in the background, so a launch does not wait for the removal.
 * A new process gets a new folder name, which this removal never reaches.
 */
export const sweepProviderTemp = Effect.fn("ProviderTemp.sweep")(function* (root: string) {
  for (const provider of yield* listFolder(root)) {
    for (const run of yield* listFolder(join(root, provider)))
      yield* Effect.forkDetach(removeDirectory(join(root, provider, run), provider).pipe(Effect.ignore));
  }
});

/** The names in a folder, or none when it cannot be read. */
function listFolder(path: string): Effect.Effect<string[]> {
  return io(() => readdir(path)).pipe(Effect.orElseSucceed((): string[] => []));
}

const removeDirectory = Effect.fn("ProviderTemp.removeDirectory")(function* (directory: string, provider: string) {
  // Windows can hold a file of a killed process for a moment after it closes.
  yield* io(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })).pipe(
    Effect.mapError(() => new ProviderTempCleanupError(provider)),
    Effect.tapError(() => Effect.sync(() => logger.warn("A provider temporary folder was not removed.", { provider }))),
  );
});

function freeDiskBytes(path: string): number {
  const filesystem = statfsSync(path);
  return filesystem.bavail * filesystem.bsize;
}
