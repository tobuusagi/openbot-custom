import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeBrowserBundleEvidence } from "./evidence.mjs";

const workspace = path.dirname(fileURLToPath(import.meta.url));

await build({
  absWorkingDir: workspace,
  entryPoints: ["./browser-entry.ts"],
  outfile: "./browser-bundle.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  mainFields: ["browser", "module", "main"],
  conditions: ["browser", "import", "default"],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

const bundleEvidence = await writeBrowserBundleEvidence();
console.log(`Built isolated bundle: ${path.join(workspace, "browser-bundle.js")}`);
console.log(`Bundle SHA-256: ${bundleEvidence.bundleSha256}`);
