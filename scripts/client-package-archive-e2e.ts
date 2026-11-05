import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { type AsarStreamType, createPackage, createPackageFromStreams, getRawHeader } from "@electron/asar";
import { createOpenBotLogger } from "@openbot/logging";
import {
  CLIENT_MAIN_ARTIFACT,
  CLIENT_PRELOAD_ARTIFACT,
  CLIENT_RENDERER_ENTRY,
  CLIENT_RENDERER_HTML,
  CLIENT_RENDERER_STYLES,
} from "../src/main/client-product";
import { assertNoResourceSymlinks, listMacBundleFiles, verifyClientArchive } from "./verify-client-package";

const CLIENT_RENDERER_IMAGE_ASSETS = [
  "out-client/renderer/assets/ball-pink.webp",
  "out-client/renderer/assets/ball-lilac.webp",
  "out-client/renderer/assets/ball-mint.webp",
  "out-client/renderer/assets/eye-right.webp",
  "out-client/renderer/assets/eye-left.webp",
  "out-client/renderer/assets/body-lilac.webp",
];

const logger = createOpenBotLogger("client-package-archive-e2e");
const outputDirectory = resolve(".openbot-build/client-package-archive-e2e");

interface ClientPackageArchiveReport {
  archiveWriter: "@electron/asar";
  normalArchiveAccepted: boolean;
  fileLinkRejected: boolean;
  directoryLinkRejected: boolean;
  rejectedMemberSegments: string[];
  internalFrameworkLinkScannedOnce: boolean;
  escapedFrameworkLinkRejected: boolean;
  frameworkLinkCycleRejected: boolean;
  applicationRootLinkRejected: boolean;
  resourceRootLinkRejected: boolean;
  completed: boolean;
  failure?: string;
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-client-archive-e2e-"));
  const report: ClientPackageArchiveReport = {
    archiveWriter: "@electron/asar",
    normalArchiveAccepted: false,
    fileLinkRejected: false,
    directoryLinkRejected: false,
    rejectedMemberSegments: [],
    internalFrameworkLinkScannedOnce: false,
    escapedFrameworkLinkRejected: false,
    frameworkLinkCycleRejected: false,
    applicationRootLinkRejected: false,
    resourceRootLinkRejected: false,
    completed: false,
  };

  try {
    const packageSource = join(temporaryRoot, "package-source");
    await createPackageSource(packageSource);
    const normalArchive = join(temporaryRoot, "client-normal.asar");
    const normalStream = await createPackage(packageSource, normalArchive);
    await finished(normalStream);
    await verifyClientArchive(normalArchive);
    report.normalArchiveAccepted = true;

    const hostEntry = join(temporaryRoot, "host-index.js");
    await writeFile(hostEntry, "Host entry content\n");
    const fileLinkArchive = join(temporaryRoot, "client-file-link.asar");
    await createLinkArchive(packageSource, hostEntry, fileLinkArchive, CLIENT_MAIN_ARTIFACT, "../../out/main/index.js");
    await expectRejected(
      () => verifyClientArchive(fileLinkArchive),
      "ASAR link entries are forbidden",
      "ASAR link at the client main file",
    );
    report.fileLinkRejected = true;

    const directoryLinkArchive = join(temporaryRoot, "client-directory-link.asar");
    await createLinkArchive(packageSource, hostEntry, directoryLinkArchive, dirname(CLIENT_MAIN_ARTIFACT), "../out");
    await expectRejected(
      () => verifyClientArchive(directoryLinkArchive),
      "ASAR link entries are forbidden",
      "ASAR link at a client directory",
    );
    report.directoryLinkRejected = true;

    const unsafeSegments = [
      "",
      ".",
      "..",
      "/absolute",
      "\\absolute",
      "nested/name",
      "nested\\name",
      "C:drive",
      "bad\0name",
    ];
    for (const [index, segment] of unsafeSegments.entries()) {
      const malformedArchive = join(temporaryRoot, `client-invalid-segment-${index}.asar`);
      await renameArchiveMember(normalArchive, malformedArchive, segment);
      await expectRejected(
        () => verifyClientArchive(malformedArchive),
        "invalid member path segment",
        `ASAR member segment ${JSON.stringify(segment)}`,
      );
      report.rejectedMemberSegments.push(JSON.stringify(segment) ?? "");
    }

    await verifyMacBundleLinks(temporaryRoot, report);
    report.completed = true;
    await writeReport(report);
    logger.info("Verified client ASAR links, member paths and package symlinks with real archive and file trees.");
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    await writeReport(report);
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function createPackageSource(root: string): Promise<void> {
  for (const path of [
    CLIENT_MAIN_ARTIFACT,
    CLIENT_PRELOAD_ARTIFACT,
    CLIENT_RENDERER_HTML,
    CLIENT_RENDERER_ENTRY,
    CLIENT_RENDERER_STYLES,
    ...CLIENT_RENDERER_IMAGE_ASSETS,
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
  }
  await writeFile(join(root, "LICENSE"), "Client license\n");
  await writeFile(join(root, "NOTICE"), "Client notice\n");
  await writeFile(join(root, CLIENT_MAIN_ARTIFACT), "client account main\n");
  await writeFile(join(root, CLIENT_PRELOAD_ARTIFACT), "client account preload\n");
  await writeFile(join(root, CLIENT_RENDERER_HTML), '<div id="root"></div>\n');
  await writeFile(join(root, CLIENT_RENDERER_ENTRY), "client account renderer\n");
  await writeFile(join(root, CLIENT_RENDERER_STYLES), "client account styles\n");
  for (const path of CLIENT_RENDERER_IMAGE_ASSETS) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "WEBP test fixture\n");
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "feitu-openbot-client", main: CLIENT_MAIN_ARTIFACT }),
  );
}

async function createLinkArchive(
  packageSource: string,
  hostEntry: string,
  archivePath: string,
  linkPath: string,
  linkTarget: string,
): Promise<void> {
  const streams: AsarStreamType[] = [];
  const packageFiles: Array<readonly [string, string]> = [
    ["LICENSE", "LICENSE"],
    ["NOTICE", "NOTICE"],
    ["package.json", "package.json"],
    [join("out-client", "preload", "client-index.cjs"), CLIENT_PRELOAD_ARTIFACT],
    [join("out-client", "renderer", "client.html"), CLIENT_RENDERER_HTML],
    [join("out-client", "renderer", "client-entry.js"), CLIENT_RENDERER_ENTRY],
    [join("out-client", "renderer", "client-entry.css"), CLIENT_RENDERER_STYLES],
    ...CLIENT_RENDERER_IMAGE_ASSETS.map((path) => [path, path] as const),
  ];
  for (const [sourceName, archiveName] of packageFiles) {
    streams.push(await fileStream(join(packageSource, sourceName), archiveName));
  }
  streams.push(await fileStream(hostEntry, "out/main/index.js"));
  streams.push({
    type: "link",
    path: linkPath,
    symlink: linkTarget,
    stat: await lstat(hostEntry),
    unpacked: false,
    streamGenerator: () => createReadStream(hostEntry),
  });

  await finished(await createPackageFromStreams(archivePath, streams));
}

async function fileStream(sourcePath: string, archivePath: string): Promise<Extract<AsarStreamType, { type: "file" }>> {
  return {
    type: "file",
    path: archivePath,
    stat: await lstat(sourcePath),
    unpacked: false,
    streamGenerator: () => createReadStream(sourcePath),
  };
}

async function renameArchiveMember(source: string, destination: string, replacement: string): Promise<void> {
  const archiveBytes = await readFile(source);
  const rawHeader = getRawHeader(source);
  const licenseEntry = rawHeader.header.files.LICENSE;
  if (!licenseEntry) throw new Error("The normal ASAR fixture has no LICENSE entry.");
  delete rawHeader.header.files.LICENSE;
  rawHeader.header.files[replacement] = licenseEntry;

  const headerJson = Buffer.from(JSON.stringify(rawHeader.header), "utf8");
  const paddedJsonLength = Math.ceil(headerJson.length / 4) * 4;
  const headerSize = 8 + paddedJsonLength;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(headerJson.length, 12);
  headerJson.copy(prefix, 16);

  const originalDataOffset = 8 + rawHeader.headerSize;
  await writeFile(destination, Buffer.concat([prefix, archiveBytes.subarray(originalDataOffset)]));
}

async function verifyMacBundleLinks(temporaryRoot: string, report: ClientPackageArchiveReport): Promise<void> {
  const bundleRoot = join(temporaryRoot, "mac-bundle");
  const frameworkRoot = join(bundleRoot, "Contents", "Frameworks", "Electron Framework.framework");
  const frameworkVersion = join(frameworkRoot, "Versions", "A");
  const frameworkBinary = join(frameworkVersion, "Electron Framework");
  await mkdir(frameworkVersion, { recursive: true });
  await writeFile(frameworkBinary, "Framework file used only for path traversal verification\n");
  await createDirectoryLink("A", join(frameworkRoot, "Versions", "Current"));

  const internalFiles = await listMacBundleFiles(bundleRoot);
  const canonicalFrameworkBinary = await realpath(frameworkBinary);
  if (internalFiles.filter((path) => path === canonicalFrameworkBinary).length !== 1) {
    throw new Error("The Mac framework link did not scan its canonical target exactly once.");
  }
  report.internalFrameworkLinkScannedOnce = true;

  const externalFramework = join(temporaryRoot, "external-framework");
  await mkdir(externalFramework, { recursive: true });
  await writeFile(join(externalFramework, "outside.bin"), "Outside the app bundle\n");
  const externalLink = join(frameworkRoot, "Escaped Framework");
  await createDirectoryLink(externalFramework, externalLink);
  await expectRejected(
    () => listMacBundleFiles(bundleRoot).then(() => undefined),
    "escapes its app root",
    "Mac framework link outside the app bundle",
  );
  report.escapedFrameworkLinkRejected = true;
  await rm(externalLink, { recursive: true, force: true });

  const cycleLink = join(frameworkVersion, "Cycle to app root");
  await createDirectoryLink(bundleRoot, cycleLink);
  await expectRejected(
    () => listMacBundleFiles(bundleRoot).then(() => undefined),
    "directory link cycle",
    "Mac framework directory link cycle",
  );
  report.frameworkLinkCycleRejected = true;

  const bundleAlias = join(temporaryRoot, "mac-bundle-alias");
  await createDirectoryLink(bundleRoot, bundleAlias);
  await expectRejected(
    () => listMacBundleFiles(bundleAlias).then(() => undefined),
    "root is a symbolic link",
    "Mac application root symlink",
  );
  report.applicationRootLinkRejected = true;

  const resourceTarget = join(temporaryRoot, "resource-target");
  const resourceAlias = join(temporaryRoot, "resource-alias");
  await mkdir(resourceTarget, { recursive: true });
  await createDirectoryLink(resourceTarget, resourceAlias);
  await expectRejected(
    () => assertNoResourceSymlinks(resourceAlias),
    "resource root is a symbolic link",
    "client resource root symlink",
  );
  report.resourceRootLinkRejected = true;
}

async function createDirectoryLink(target: string, path: string): Promise<void> {
  const resolvedTarget = process.platform === "win32" && !isAbsolute(target) ? resolve(dirname(path), target) : target;
  await symlink(resolvedTarget, path, process.platform === "win32" ? "junction" : "dir");
}

async function expectRejected(operation: () => Promise<void>, expectedMessage: string, label: string): Promise<string> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) return message;
    throw new Error(`${label} failed for the wrong reason: ${message}`);
  }
  throw new Error(`${label} was accepted.`);
}

async function writeReport(report: ClientPackageArchiveReport): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) await main();
