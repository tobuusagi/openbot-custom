import { chromium } from "playwright-core";
import { verifyBrowserBundleEvidence, writeEvidence } from "./evidence.mjs";

let browser;
let report;
let verifiedBrowserBundle = null;
let browserBundleMetadata = null;
let browserVersion = null;
let phase = "browser bundle verification";

try {
  verifiedBrowserBundle = await verifyBrowserBundleEvidence();
  browserBundleMetadata = verifiedBrowserBundle.metadata;
  phase = "Chromium launch";
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  browserVersion = browser.version();

  phase = "browser bundle execution";
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ content: verifiedBrowserBundle.source });
  report = await page.evaluate(async () => {
    const result = globalThis.noiseSpikePromise;
    if (result == null) {
      throw new Error("Browser bundle did not start the spike");
    }
    return await result;
  });
} catch (error) {
  const blocked = browser == null && phase === "Chromium launch";
  report = {
    runtime: "Chromium browser bundle",
    protocol: "Noise_XX_25519_ChaChaPoly_SHA256",
    library: "@chainsafe/libp2p-noise@17.0.0",
    status: blocked ? "blocked" : "failed",
    blocker: blocked ? errorName(error) : undefined,
    blockerDetail: blocked ? errorMessage(error) : undefined,
    checks: blocked ? [] : [{ name: phase, passed: false, error: errorName(error) }],
    checkCounts: blocked ? { total: 0, passed: 0, failed: 0 } : { total: 1, passed: 0, failed: 1 },
    limits: ["Browser launch uses Chromium with chromiumSandbox: true."],
  };
} finally {
  if (browser != null) {
    await browser.close();
  }
}

const outputPath = await writeEvidence(
  report,
  {
    runtime: "Chromium browser bundle",
    chromiumVersion: browserVersion,
    executablePath: "/usr/bin/chromium",
    chromiumSandbox: true,
    launcherNodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    browserBundle:
      browserBundleMetadata == null
        ? null
        : {
            runId: browserBundleMetadata.runId,
            sourceDigest: browserBundleMetadata.sourceDigest,
            lockDigest: browserBundleMetadata.lockDigest,
            sha256: browserBundleMetadata.bundleSha256,
          },
  },
  "chromium.json",
);

console.log(`${report.status}: ${report.checkCounts.passed}/${report.checkCounts.total} checks passed`);
if (report.blocker != null) {
  console.log(`Blocked: ${report.blocker}`);
}
console.log(`Evidence: ${outputPath}`);

if (report.status !== "passed") {
  process.exitCode = 1;
}

function errorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

function errorMessage(error) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown browser launch error";
}
