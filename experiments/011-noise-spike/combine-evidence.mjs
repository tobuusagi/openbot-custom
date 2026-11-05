import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evidenceRootDirectory,
  evidenceRunDirectory,
  getPackageState,
  readActiveEvidenceRun,
  sameJson,
  verifyBrowserBundleEvidence,
} from "./evidence.mjs";

const evidenceDirectory = evidenceRootDirectory();
const reportNames = ["node.json", "bun.json", "chromium.json"];
const reports = [];
const missingReports = [];
const validationIssues = [];
const activeRun = await readActiveEvidenceRun();
const packageState = await getPackageState();
const runDirectory = evidenceRunDirectory(activeRun.runId);
let browserBundleMetadata = null;

try {
  const verifiedBrowserBundle = await verifyBrowserBundleEvidence();
  browserBundleMetadata = verifiedBrowserBundle.metadata;
} catch {
  validationIssues.push("browser bundle metadata or bytes do not match the active evidence run");
}

if (activeRun.schemaVersion !== 1 || activeRun.runId == null) {
  validationIssues.push("active evidence run metadata is invalid");
}
if (packageState.consistencyIssues.length > 0) {
  validationIssues.push(...packageState.consistencyIssues);
}
if (activeRun.sourceDigest !== packageState.sourceDigest) {
  validationIssues.push("active run source digest does not match the current package source");
}
if (activeRun.lockDigest !== packageState.lockDigest) {
  validationIssues.push("active run lock digest does not match the current package lockfile");
}
if (
  !sameJson(activeRun.pinnedDependencies, packageState.pinnedDependencies) ||
  !sameJson(activeRun.pinnedDevDependencies, packageState.pinnedDevDependencies)
) {
  validationIssues.push("active run dependency pins do not match the current package manifest");
}

for (const name of reportNames) {
  try {
    reports.push({ name, evidence: JSON.parse(await readFile(path.join(runDirectory, name), "utf8")) });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      validationIssues.push(`${name} is invalid JSON`);
      continue;
    }
    missingReports.push(name);
  }
}

const startedAt = Date.parse(activeRun.startedAt);
if (!Number.isFinite(startedAt)) {
  validationIssues.push("active run start time is invalid");
}

for (const { name, evidence } of reports) {
  const generatedAt = Date.parse(evidence.generatedAt);
  if (evidence.schemaVersion !== 1) {
    validationIssues.push(`${name} has an unsupported evidence schema`);
  }
  if (evidence.runId !== activeRun.runId) {
    validationIssues.push(`${name} belongs to a different evidence run`);
  }
  if (evidence.sourceDigest !== packageState.sourceDigest) {
    validationIssues.push(`${name} source digest is stale or mismatched`);
  }
  if (evidence.lockDigest !== packageState.lockDigest) {
    validationIssues.push(`${name} lock digest is stale or mismatched`);
  }
  if (
    !sameJson(evidence.package?.pinnedDependencies, packageState.pinnedDependencies) ||
    !sameJson(evidence.package?.pinnedDevDependencies, packageState.pinnedDevDependencies)
  ) {
    validationIssues.push(`${name} dependency pins do not match the current package manifest`);
  }
  if (
    !sameJson(evidence.package, {
      ...packageState.noisePackage,
      priorPublicMetadataReview: {
        deprecationStatus: "No deprecation notice was found in the prior public metadata review.",
        archiveLicense: "Apache-2.0 OR MIT",
      },
      pinnedDependencies: packageState.pinnedDependencies,
      pinnedDevDependencies: packageState.pinnedDevDependencies,
    })
  ) {
    validationIssues.push(`${name} Noise package metadata does not match the current lockfile`);
  }
  if (Number.isFinite(startedAt) && (!Number.isFinite(generatedAt) || generatedAt < startedAt)) {
    validationIssues.push(`${name} was generated before the current evidence run`);
  }

  const counts = evidence.result?.checkCounts;
  const checks = evidence.result?.checks;
  if (
    counts == null ||
    !Number.isInteger(counts.total) ||
    counts.total < 1 ||
    counts.passed !== counts.total ||
    counts.failed !== 0 ||
    !Array.isArray(checks) ||
    checks.length !== counts.total ||
    checks.some((check) => check.passed !== true)
  ) {
    validationIssues.push(`${name} does not contain a complete passing check report`);
  }
  if (evidence.result?.status !== "passed") {
    validationIssues.push(`${name} runtime status is ${evidence.result?.status ?? "missing"}`);
  }
  if (name === "chromium.json") {
    const bundleMetadata =
      browserBundleMetadata == null
        ? null
        : {
            runId: browserBundleMetadata.runId,
            sourceDigest: browserBundleMetadata.sourceDigest,
            lockDigest: browserBundleMetadata.lockDigest,
            sha256: browserBundleMetadata.bundleSha256,
          };
    if (bundleMetadata == null || !sameJson(evidence.runtimeDetails?.browserBundle, bundleMetadata)) {
      validationIssues.push(`${name} does not record the verified browser bundle`);
    }
  }
  validateRuntime(name, evidence, validationIssues);
}

const total = reports.reduce((sum, { evidence }) => sum + (evidence.result?.checkCounts?.total ?? 0), 0);
const passed = reports.reduce((sum, { evidence }) => sum + (evidence.result?.checkCounts?.passed ?? 0), 0);
const failed = reports.reduce((sum, { evidence }) => sum + (evidence.result?.checkCounts?.failed ?? 0), 0);
const blocked = reports.filter(({ evidence }) => evidence.result?.status === "blocked").length;
const status =
  validationIssues.length > 0
    ? blocked > 0
      ? "partial"
      : "failed"
    : missingReports.length > 0
      ? "incomplete"
      : "passed";
const combined = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runId: activeRun.runId,
  startedAt: activeRun.startedAt,
  sourceDigest: packageState.sourceDigest,
  lockDigest: packageState.lockDigest,
  status,
  checkCounts: { total, passed, failed },
  missingReports,
  validationIssues,
  blockedRuntimes: reports
    .filter(({ evidence }) => evidence.result?.status === "blocked")
    .map(({ evidence }) => ({ runtime: evidence.result.runtime, blocker: evidence.result.blocker })),
  runtimes: reports.map(({ evidence }) => evidence),
  platformGaps: [
    "Physical Electron macOS ARM64 was not tested.",
    "Physical Electron Windows ARM64 was not tested.",
    "Android WebView was not tested.",
  ],
  conclusionLimit:
    "This isolated spike is feasibility evidence only and does not approve product WSS or key management.",
};

await mkdir(runDirectory, { recursive: true });
const outputPath = path.join(evidenceDirectory, "report.json");
const serializedReport = `${JSON.stringify(combined, null, 2)}\n`;
await writeFile(outputPath, serializedReport, { mode: 0o600 });
await writeFile(path.join(runDirectory, "report.json"), serializedReport, { mode: 0o600 });
console.log(`${status}: ${passed}/${total} checks passed; ${blocked} runtime(s) blocked`);
console.log(`Evidence: ${outputPath}`);
for (const issue of validationIssues) {
  console.log(`Rejected: ${issue}`);
}

if (status !== "passed" || missingReports.length > 0) {
  process.exitCode = 1;
}

function validateRuntime(name, evidence, issues) {
  const details = evidence.runtimeDetails ?? {};
  if (name === "node.json") {
    if (!/^v?24\./.test(details.nodeVersion ?? "") || details.bunVersion != null) {
      issues.push(`${name} was not produced by Node 24`);
    }
  } else if (name === "bun.json") {
    if (details.bunVersion !== "1.4.2") {
      issues.push(`${name} was not produced by Bun 1.4.2`);
    }
  } else if (name === "chromium.json") {
    if (
      details.chromiumSandbox !== true ||
      typeof details.chromiumVersion !== "string" ||
      details.chromiumVersion.length === 0 ||
      !/^v?24\./.test(details.launcherNodeVersion ?? "")
    ) {
      issues.push(`${name} does not record a sandboxed Chromium run under Node 24`);
    }
  }
}
