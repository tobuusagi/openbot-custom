import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.dirname(fileURLToPath(import.meta.url));
const evidenceDirectory = path.resolve(workspace, "../../.openbot-build/011-noise-spike/evidence");
const activeRunPath = path.join(evidenceDirectory, "active-run.json");
const browserBundlePath = path.join(workspace, "browser-bundle.js");
const browserBundleMetadataPath = path.join(workspace, "browser-bundle.json");
const runIdPattern = /^\d{17}-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export async function getPackageState() {
  const packageJson = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
  const packageLockText = await readFile(path.join(workspace, "package-lock.json"), "utf8");
  const packageLock = JSON.parse(packageLockText);
  const sourceDigest = await getSourceDigest();
  const lockDigest = digest(packageLockText);
  const pinnedDependencies = sortObject(packageJson.dependencies ?? {});
  const pinnedDevDependencies = sortObject(packageJson.devDependencies ?? {});
  const lockRoot = packageLock.packages?.[""];
  const consistencyIssues = [];

  if (lockRoot == null) {
    consistencyIssues.push("package-lock.json has no root package entry");
  } else {
    if (!sameJson(sortObject(lockRoot.dependencies ?? {}), pinnedDependencies)) {
      consistencyIssues.push("package-lock.json runtime pins do not match package.json");
    }
    if (!sameJson(sortObject(lockRoot.devDependencies ?? {}), pinnedDevDependencies)) {
      consistencyIssues.push("package-lock.json development pins do not match package.json");
    }
  }

  for (const [name, version] of Object.entries({ ...pinnedDependencies, ...pinnedDevDependencies })) {
    const lockedPackage = packageLock.packages?.[`node_modules/${name}`];
    if (lockedPackage?.version !== version) {
      consistencyIssues.push(`package-lock.json does not resolve ${name}@${version} exactly`);
    }
  }

  const noisePackage = packageLock.packages?.["node_modules/@chainsafe/libp2p-noise"];
  if (noisePackage == null) {
    consistencyIssues.push("package-lock.json has no @chainsafe/libp2p-noise entry");
  }

  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageLicense: packageJson.license,
    pinnedDependencies,
    pinnedDevDependencies,
    sourceDigest,
    lockDigest,
    noisePackage:
      noisePackage == null
        ? null
        : {
            name: "@chainsafe/libp2p-noise",
            version: noisePackage.version,
            resolved: noisePackage.resolved,
            integrity: noisePackage.integrity,
            license: noisePackage.license,
          },
    consistencyIssues,
  };
}

export async function beginEvidenceRun() {
  const packageState = await getPackageState();
  if (packageState.consistencyIssues.length > 0) {
    throw new Error(packageState.consistencyIssues.join("; "));
  }

  const startedAt = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    runId: `${startedAt.replaceAll(/[^0-9]/g, "")}-${randomUUID()}`,
    startedAt,
    ...packageState,
  };
  const runDirectory = evidenceRunDirectory(run.runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(activeRunPath, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  return run;
}

export async function readActiveEvidenceRun() {
  const activeRun = JSON.parse(await readFile(activeRunPath, "utf8"));
  if (activeRun == null || !runIdPattern.test(activeRun.runId ?? "")) {
    throw new Error("Active evidence run metadata is invalid; start a new evidence run");
  }
  return activeRun;
}

export async function writeEvidence(testReport, runtimeDetails, fileName) {
  const activeRun = await readActiveEvidenceRun();
  const packageState = await getPackageState();
  assertCurrentRun(activeRun, packageState);

  const runDirectory = evidenceRunDirectory(activeRun.runId);
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: activeRun.runId,
    startedAt: activeRun.startedAt,
    sourceDigest: packageState.sourceDigest,
    lockDigest: packageState.lockDigest,
    result: testReport,
    runtimeDetails,
    package: {
      ...packageState.noisePackage,
      priorPublicMetadataReview: {
        deprecationStatus: "No deprecation notice was found in the prior public metadata review.",
        archiveLicense: "Apache-2.0 OR MIT",
      },
      pinnedDependencies: packageState.pinnedDependencies,
      pinnedDevDependencies: packageState.pinnedDevDependencies,
    },
    platformGaps: [
      {
        target: "Electron macOS ARM64 physical device",
        status: "not tested",
        reason: "This isolated experiment has no physical target device.",
      },
      {
        target: "Electron Windows ARM64 physical device",
        status: "not tested",
        reason: "This isolated experiment has no physical target device.",
      },
      {
        target: "Android WebView physical device",
        status: "not tested",
        reason: "This isolated experiment has no Android WebView device.",
      },
    ],
    reproduction: [
      "From the isolated package workspace, run `node ./spike.mjs` for Node 24.",
      "From the isolated package workspace, run `bun ./spike.mjs` for Bun.",
      "Run `node ./bundle-browser.mjs` to build the isolated browser bundle.",
      "Run `node ./chromium-run.mjs` to execute it in Chromium with `chromiumSandbox: true`.",
      "The test identities and Noise keys are generated in memory and are not written to disk.",
      "Do not pass `--no-sandbox` or use production credentials or traffic.",
    ],
  };

  await mkdir(runDirectory, { recursive: true });
  const outputPath = path.join(runDirectory, fileName);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return outputPath;
}

export async function writeBrowserBundleEvidence() {
  const activeRun = await readActiveEvidenceRun();
  const packageState = await getPackageState();
  assertCurrentRun(activeRun, packageState);

  const bundle = await readFile(browserBundlePath);
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: activeRun.runId,
    sourceDigest: packageState.sourceDigest,
    lockDigest: packageState.lockDigest,
    bundleSha256: digest(bundle),
  };
  await writeFile(browserBundleMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return metadata;
}

export async function verifyBrowserBundleEvidence() {
  const activeRun = await readActiveEvidenceRun();
  const packageState = await getPackageState();
  assertCurrentRun(activeRun, packageState);

  const metadata = JSON.parse(await readFile(browserBundleMetadataPath, "utf8"));
  const bundle = await readFile(browserBundlePath);
  const generatedAt = Date.parse(metadata.generatedAt);
  const startedAt = Date.parse(activeRun.startedAt);

  if (
    metadata.schemaVersion !== 1 ||
    metadata.runId !== activeRun.runId ||
    metadata.sourceDigest !== packageState.sourceDigest ||
    metadata.lockDigest !== packageState.lockDigest ||
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(startedAt) ||
    generatedAt < startedAt
  ) {
    throw new Error(
      "Browser bundle metadata is stale or does not match the active evidence run; rebuild the browser bundle",
    );
  }
  if (metadata.bundleSha256 !== digest(bundle)) {
    throw new Error("Browser bundle bytes do not match their recorded SHA-256; rebuild the browser bundle");
  }
  return { metadata, source: bundle.toString("utf8") };
}

export function evidenceRunDirectory(runId) {
  if (!runIdPattern.test(runId ?? "")) {
    throw new Error("Evidence run ID is invalid");
  }
  return path.join(evidenceDirectory, "runs", runId);
}

export function evidenceRootDirectory() {
  return evidenceDirectory;
}

export function sameJson(left, right) {
  return JSON.stringify(sortDeep(left)) === JSON.stringify(sortDeep(right));
}

export function assertCurrentRun(activeRun, packageState) {
  if (activeRun.schemaVersion !== 1 || activeRun.runId == null) {
    throw new Error("Active evidence run metadata is invalid; start a new evidence run");
  }
  if (packageState.consistencyIssues.length > 0) {
    throw new Error(packageState.consistencyIssues.join("; "));
  }
  if (activeRun.sourceDigest !== packageState.sourceDigest || activeRun.lockDigest !== packageState.lockDigest) {
    throw new Error("The source or lockfile changed after evidence:start; start a new evidence run");
  }
  if (
    !sameJson(activeRun.pinnedDependencies, packageState.pinnedDependencies) ||
    !sameJson(activeRun.pinnedDevDependencies, packageState.pinnedDevDependencies)
  ) {
    throw new Error("The package pins changed after evidence:start; start a new evidence run");
  }
}

async function getSourceDigest() {
  const files = await listSourceFiles(workspace);
  const hash = createHash("sha256");

  for (const file of files) {
    const relativePath = path.relative(workspace, file).split(path.sep).join("/");
    const content = await readFile(file);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === "browser-bundle.js" || entry.name === "browser-bundle.json") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortDeep(child)]),
    );
  }
  return value;
}
