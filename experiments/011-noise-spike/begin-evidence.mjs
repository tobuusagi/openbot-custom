import { beginEvidenceRun } from "./evidence.mjs";

const run = await beginEvidenceRun();
console.log(`Evidence run: ${run.runId}`);
console.log(`Source SHA-256: ${run.sourceDigest}`);
console.log(`Lock SHA-256: ${run.lockDigest}`);
