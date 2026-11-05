import { runNoiseLibrarySpike } from "./noise-library-spike.ts";

Object.defineProperty(globalThis, "noiseSpikePromise", {
  configurable: true,
  value: runNoiseLibrarySpike("Chromium browser bundle"),
});
