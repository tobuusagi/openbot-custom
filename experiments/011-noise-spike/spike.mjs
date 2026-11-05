import { writeEvidence } from "./evidence.mjs";
import { runNoiseLibrarySpike } from "./noise-library-spike.ts";

const bunVersion = process.versions.bun;
const runtime = bunVersion == null ? `Node ${process.version}` : `Bun ${bunVersion}`;
const report = await runNoiseLibrarySpike(runtime);
const outputPath = await writeEvidence(
  report,
  {
    runtime,
    processVersion: process.version,
    nodeVersion: bunVersion == null ? process.version : null,
    bunVersion: bunVersion ?? null,
    platform: process.platform,
    architecture: process.arch,
  },
  bunVersion == null ? "node.json" : "bun.json",
);

console.log(`${report.status}: ${report.checkCounts.passed}/${report.checkCounts.total} checks passed`);
console.log(`Evidence: ${outputPath}`);

if (report.status !== "passed") {
  process.exitCode = 1;
}
