import { extname, resolve } from "node:path";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const outputRoot = resolve("out-client-e2e");

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@openbot/contracts",
          "@openbot/i18n",
          "@openbot/logging",
          "@openbot/user-errors",
          "effect",
          "jose",
          "ts-log",
          "zod",
        ],
      }),
    ],
    build: {
      outDir: joinOutput("main"),
      emptyOutDir: true,
      rollupOptions: {
        input: { "e2e-index": resolve("src/main/client-e2e-index.ts") },
        output: { entryFileNames: "e2e-index.js", inlineDynamicImports: true },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@openbot/contracts"] })],
    build: {
      outDir: joinOutput("preload"),
      emptyOutDir: true,
      rollupOptions: {
        input: { "client-index": resolve("src/preload/client-index.ts") },
        output: { entryFileNames: "client-index.cjs", format: "cjs", inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [solidPlugin(), tailwindcss({ optimize: false })],
    resolve: { dedupe: ["solid-js", "@solidjs/web"] },
    build: {
      outDir: joinOutput("renderer"),
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

function joinOutput(child: string): string {
  return resolve(outputRoot, child);
}
