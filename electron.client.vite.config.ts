import { basename, dirname, extname, resolve } from "node:path";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { CLIENT_MAIN_ARTIFACT, CLIENT_MAIN_SOURCE, CLIENT_PRELOAD_ARTIFACT } from "./src/main/client-product";

const mainArtifact = resolve(CLIENT_MAIN_ARTIFACT);
const preloadArtifact = resolve(CLIENT_PRELOAD_ARTIFACT);

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@openbot/contracts",
          "@openbot/i18n",
          "@openbot/logging",
          "@openbot/team-client",
          "@openbot/user-errors",
          "effect",
          "jose",
          "ts-log",
          "zod",
        ],
      }),
    ],
    build: {
      outDir: dirname(mainArtifact),
      emptyOutDir: true,
      rollupOptions: {
        input: { "client-index": resolve(CLIENT_MAIN_SOURCE) },
        output: { entryFileNames: basename(mainArtifact), inlineDynamicImports: true },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@openbot/contracts"] })],
    build: {
      outDir: dirname(preloadArtifact),
      emptyOutDir: true,
      rollupOptions: {
        input: { "client-index": resolve("src/preload/client-index.ts") },
        output: { entryFileNames: basename(preloadArtifact), format: "cjs", inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [solidPlugin(), tailwindcss({ optimize: false })],
    resolve: { dedupe: ["solid-js", "@solidjs/web"] },
    build: {
      outDir: resolve("out-client/renderer"),
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: { client: resolve("src/renderer/client.html") },
        output: {
          entryFileNames: "client-entry.js",
          assetFileNames: (assetInfo) =>
            assetInfo.name && extname(assetInfo.name).toLowerCase() === ".css"
              ? "client-entry.css"
              : "assets/[name][extname]",
          inlineDynamicImports: true,
        },
      },
    },
  },
});
