import { execFileSync } from "node:child_process";
import { access, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isMissingFileError } from "../src/backend/file-errors";
import {
  CLIENT_MAIN_ARTIFACT,
  CLIENT_MAIN_SOURCE,
  CLIENT_PRELOAD_ARTIFACT,
  CLIENT_PRODUCT,
  CLIENT_RENDERER_ENTRY,
  CLIENT_RENDERER_HTML,
  CLIENT_RENDERER_STYLES,
} from "../src/main/client-product";

const CLIENT_RENDERER_IMAGE_ASSETS = [
  "out-client/renderer/assets/ball-pink.webp",
  "out-client/renderer/assets/ball-lilac.webp",
  "out-client/renderer/assets/ball-mint.webp",
  "out-client/renderer/assets/eye-right.webp",
  "out-client/renderer/assets/eye-left.webp",
  "out-client/renderer/assets/body-lilac.webp",
];

const logger = createOpenBotLogger("verify-client-package");
const WINDOWS_ARM64_MACHINE = 0xaa64;
const CLIENT_PACKAGE_FILES = new Set([
  "LICENSE",
  "NOTICE",
  CLIENT_MAIN_ARTIFACT,
  CLIENT_PRELOAD_ARTIFACT,
  CLIENT_RENDERER_HTML,
  CLIENT_RENDERER_ENTRY,
  CLIENT_RENDERER_STYLES,
  ...CLIENT_RENDERER_IMAGE_ASSETS,
  "package.json",
]);
const FORBIDDEN_RESOURCE_NAMES = new Set([
  "agent-runtime",
  "claude",
  "cli",
  "cloudflared",
  "codex",
  "cua-driver",
  "grok",
  "managed-skills",
  "remote-desktop-runtime",
  "voice",
]);
const WINDOWS_RESOURCE_FILES = new Set(["app.asar", "licenses/Electron-LICENSE", "licenses/LICENSES.chromium.html"]);
const MAC_RESOURCE_FILES = new Set([
  "app.asar",
  "icon.icns",
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
  "licenses/Electron-LICENSE",
  "licenses/LICENSES.chromium.html",
]);
const MACH_O_MAGICS = new Set([
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

const packageTargetSchema = z.object({ target: z.string(), arch: z.array(z.string()) }).strict();
const clientBuilderSchema = z
  .object({
    appId: z.string(),
    productName: z.string(),
    executableName: z.string(),
    copyright: z.string(),
    asar: z.boolean(),
    artifactName: z.string(),
    publish: z.null(),
    extraResources: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
    asarUnpack: z.array(z.string()),
    nodeGypRebuild: z.boolean(),
    npmRebuild: z.boolean(),
    buildDependenciesFromSource: z.boolean(),
    directories: z.object({ output: z.string() }).strict(),
    extraMetadata: z
      .object({
        name: z.string(),
        productName: z.string(),
        main: z.string(),
        feituClientRole: z.string(),
        feituClientRuntimeStatus: z.string(),
        feituClientApplicationId: z.string(),
        feituClientProtocolScheme: z.string(),
        feituClientDefaultApiOrigin: z.string(),
        feituClientDefaultConnectOrigin: z.string(),
        feituClientUpdateChannel: z.string(),
        feituClientUpdateFeed: z.null(),
      })
      .strict(),
    files: z.array(z.string()),
    electronFuses: z
      .object({
        resetAdHocDarwinSignature: z.boolean(),
        runAsNode: z.boolean(),
        enableCookieEncryption: z.boolean(),
        enableNodeOptionsEnvironmentVariable: z.boolean(),
        enableNodeCliInspectArguments: z.boolean(),
        enableEmbeddedAsarIntegrityValidation: z.boolean(),
        onlyLoadAppFromAsar: z.boolean(),
        loadBrowserProcessSpecificV8Snapshot: z.boolean(),
        grantFileProtocolExtraPrivileges: z.boolean(),
      })
      .strict(),
    protocols: z.array(z.object({ name: z.string(), schemes: z.array(z.string()) }).strict()),
    win: z
      .object({
        icon: z.string(),
        target: z.array(packageTargetSchema),
      })
      .strict(),
    mac: z
      .object({
        category: z.string(),
        minimumSystemVersion: z.string(),
        icon: z.string(),
        identity: z.null(),
        notarize: z.boolean(),
        target: z.array(packageTargetSchema),
      })
      .strict(),
    nsis: z
      .object({
        oneClick: z.boolean(),
        allowToChangeInstallationDirectory: z.boolean(),
        allowElevation: z.boolean(),
        packElevateHelper: z.boolean(),
      })
      .strict(),
  })
  .strict();

interface AsarIntegrity {
  algorithm: "SHA256";
  hash: string;
  blockSize: number;
  blocks: string[];
}

interface AsarEntry {
  files?: { [name: string]: AsarEntry };
  offset?: string;
  size?: number;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
  integrity?: AsarIntegrity;
}

const asarIntegritySchema = z
  .object({
    algorithm: z.literal("SHA256"),
    hash: z.string().regex(/^[0-9a-f]{64}$/u),
    blockSize: z.number().int().positive(),
    blocks: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
  })
  .strict();
const asarEntrySchema: z.ZodType<AsarEntry> = z.lazy(() =>
  z
    .object({
      files: z.record(z.string(), asarEntrySchema).optional(),
      offset: z
        .string()
        .regex(/^(0|[1-9]\d*)$/u)
        .optional(),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      unpacked: z.boolean().optional(),
      executable: z.boolean().optional(),
      link: z.string().optional(),
      integrity: asarIntegritySchema.optional(),
    })
    .strict(),
);
const asarHeaderSchema = z
  .object({
    files: z.record(z.string(), asarEntrySchema),
    integrity: asarIntegritySchema.optional(),
  })
  .strict();
type AsarDirectory = z.output<typeof asarHeaderSchema>["files"];
const clientManifestSchema = z.object({
  name: z.string(),
  productName: z.string(),
  main: z.string(),
  version: z.string(),
  feituClientRole: z.string(),
  feituClientRuntimeStatus: z.string(),
  feituClientApplicationId: z.string(),
  feituClientProtocolScheme: z.string(),
  feituClientDefaultApiOrigin: z.string(),
  feituClientDefaultConnectOrigin: z.string(),
  feituClientUpdateChannel: z.string(),
  feituClientUpdateFeed: z.null(),
});
const windowsVersionSchema = z.object({
  ProductName: z.string(),
  FileDescription: z.string(),
  ProductVersion: z.string(),
});
const macInfoSchema = z.object({
  CFBundleDisplayName: z.string(),
  CFBundleExecutable: z.string(),
  CFBundleIdentifier: z.string(),
  CFBundleShortVersionString: z.string(),
  CFBundleURLTypes: z.array(z.object({ CFBundleURLSchemes: z.array(z.string()).optional() })).optional(),
});
const packageVersionSchema = z.object({ version: z.string() });

async function main(): Promise<void> {
  const configOnly = process.argv.includes("--config-only");
  const artifactArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

  await verifyBuildConfiguration();
  if (configOnly) {
    logger.info("Verified the Feitu client build configuration; runtime status is account-shell.");
    return;
  }

  if (process.arch !== "arm64") {
    throw new Error(`Run package verification with native ARM64 Node/Bun; this process is ${process.arch}.`);
  }
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error(`The Feitu client package has no ${process.platform} target.`);
  }

  const appPath = resolve(artifactArgument ?? defaultArtifactPath());
  const packageVersion = await readWorkspaceVersion();
  const result =
    process.platform === "win32"
      ? await verifyWindowsPackage(appPath, packageVersion)
      : await verifyMacPackage(appPath, packageVersion);

  await mkdir(resolve(".openbot-build"), { recursive: true });
  await writeFile(
    resolve(".openbot-build/client-package-verification.json"),
    `${JSON.stringify(
      {
        product: CLIENT_PRODUCT.productName,
        applicationId: CLIENT_PRODUCT.applicationId,
        platform: process.platform,
        architecture: process.arch,
        artifact: relative(process.cwd(), appPath),
        runtimeStatus: CLIENT_PRODUCT.runtimeStatus,
        updateFeed: CLIENT_PRODUCT.updateFeed,
        nativeBinaryCount: result.nativeBinaryCount,
        verified: true,
      },
      null,
      2,
    )}\n`,
  );
  logger.info(
    `Verified ${CLIENT_PRODUCT.productName} · ${process.platform} ARM64 · distinct identity · no updater feed · ${result.nativeBinaryCount} native binaries`,
  );
}

async function verifyBuildConfiguration(): Promise<void> {
  const [builderText, viteText, sourceText, entryText] = await Promise.all([
    readFile("electron-builder.client.yml", "utf8"),
    readFile("electron.client.vite.config.ts", "utf8"),
    readFile("src/main/client-product.ts", "utf8"),
    readFile(CLIENT_MAIN_SOURCE, "utf8"),
  ]);
  const builder = clientBuilderSchema.parse(parseYaml(builderText));

  expectEqual(builder.appId, CLIENT_PRODUCT.applicationId, "builder application ID");
  expectEqual(builder.productName, CLIENT_PRODUCT.productName, "builder product name");
  expectEqual(builder.executableName, CLIENT_PRODUCT.executableName, "builder executable name");
  expectEqual(builder.copyright, "Copyright © 2026 Feitu", "client copyright");
  expectEqual(builder.asar, true, "ASAR packaging");
  expectEqual(builder.artifactName, `\${productName}-\${version}-\${arch}.\${ext}`, "artifact name");
  expectEqual(builder.publish, null, "client updater provider");
  expectEqual(
    builder.extraResources,
    [
      { from: "node_modules/electron/dist/LICENSE", to: "licenses/Electron-LICENSE" },
      { from: "node_modules/electron/dist/LICENSES.chromium.html", to: "licenses/LICENSES.chromium.html" },
    ],
    "legal resource allowlist",
  );
  expectEqual(builder.asarUnpack, [], "unpacked ASAR files");
  expectEqual(builder.nodeGypRebuild, false, "native dependency rebuild");
  expectEqual(builder.npmRebuild, false, "native dependency rebuild");
  expectEqual(builder.buildDependenciesFromSource, false, "native dependency build");
  expectEqual(
    builder.electronFuses,
    {
      resetAdHocDarwinSignature: true,
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    "Electron security fuses",
  );

  expectEqual(builder.directories.output, "dist/client", "client output directory");
  const metadata = builder.extraMetadata;
  expectEqual(metadata.main, CLIENT_MAIN_ARTIFACT, "dedicated main entry");
  expectEqual(metadata.name, "feitu-openbot-client", "packaged application name");
  expectEqual(metadata.feituClientRole, CLIENT_PRODUCT.role, "packaged product role");
  expectEqual(metadata.feituClientRuntimeStatus, CLIENT_PRODUCT.runtimeStatus, "packaged runtime status");
  expectEqual(metadata.feituClientApplicationId, CLIENT_PRODUCT.applicationId, "packaged application ID");
  expectEqual(metadata.feituClientProtocolScheme, CLIENT_PRODUCT.protocolScheme, "packaged URL scheme");
  expectEqual(metadata.feituClientDefaultApiOrigin, CLIENT_PRODUCT.defaultApiOrigin, "default account API");
  expectEqual(metadata.feituClientDefaultConnectOrigin, CLIENT_PRODUCT.defaultConnectOrigin, "default connect origin");
  expectEqual(metadata.feituClientUpdateChannel, CLIENT_PRODUCT.updateChannel, "independent update channel name");
  expectEqual(metadata.feituClientUpdateFeed, null, "client update feed");

  const files = builder.files;
  const expectedFiles = [
    CLIENT_MAIN_ARTIFACT,
    CLIENT_PRELOAD_ARTIFACT,
    CLIENT_RENDERER_HTML,
    CLIENT_RENDERER_ENTRY,
    CLIENT_RENDERER_STYLES,
    ...CLIENT_RENDERER_IMAGE_ASSETS,
    "package.json",
    "LICENSE",
    "NOTICE",
    "!out/**/*",
    "!node_modules/**/*",
  ];
  expectEqual(JSON.stringify(files), JSON.stringify(expectedFiles), "package file allowlist");
  const includedFiles = files.filter((file) => !file.startsWith("!"));
  if (includedFiles.some((file) => file.includes("*") || file.startsWith("out/"))) {
    throw new Error("The client package includes a broad or Host build output pattern.");
  }

  expectEqual(
    builder.protocols,
    [{ name: "Feitu OpenBot client links", schemes: [CLIENT_PRODUCT.protocolScheme] }],
    "client URL protocol",
  );

  expectEqual(builder.win.icon, "build/icon-production.ico", "Windows icon");
  const windowsTargets = builder.win.target;
  const [windowsTarget] = windowsTargets;
  if (
    windowsTargets.length !== 1 ||
    !windowsTarget ||
    windowsTarget.target !== "nsis" ||
    JSON.stringify(windowsTarget.arch) !== JSON.stringify(["arm64"])
  ) {
    throw new Error("The client Windows target must be native ARM64 NSIS only.");
  }
  expectEqual(
    builder.nsis,
    {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      allowElevation: false,
      packElevateHelper: false,
    },
    "Windows installer configuration",
  );
  const mac = builder.mac;
  if (mac.identity !== null || mac.notarize !== false) {
    throw new Error("The account shell must not imply that signing or notarization is configured.");
  }
  expectEqual(mac.category, "public.app-category.productivity", "macOS category");
  expectEqual(mac.minimumSystemVersion, "13.0", "minimum macOS version");
  expectEqual(mac.icon, "build/icon-production.icns", "macOS icon");
  const macTargets = mac.target;
  const validMacTargets = new Set(["dmg", "zip"]);
  const selectedMacTargets = new Set(macTargets.map((target) => target.target));
  if (
    macTargets.length !== validMacTargets.size ||
    selectedMacTargets.size !== validMacTargets.size ||
    [...selectedMacTargets].some((target) => !validMacTargets.has(target)) ||
    macTargets.some((target) => JSON.stringify(target.arch) !== JSON.stringify(["arm64"]))
  ) {
    throw new Error("The client macOS targets must be native ARM64 DMG and ZIP only.");
  }

  if (CLIENT_PRODUCT.role !== "client" || CLIENT_PRODUCT.runtimeStatus !== "account-shell") {
    throw new Error("The client product metadata must remain closed to the account-shell runtime.");
  }
  if (CLIENT_PRODUCT.updateFeed !== null || /process\.env/u.test(sourceText) || /process\.env/u.test(entryText)) {
    throw new Error("The client identity, defaults and absent update feed cannot be overridden by environment.");
  }
  const imports = [...entryText.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const allowedImports = new Set(["electron", "node:path", "./client-product", "./client-runtime"]);
  if (imports.some((name) => !allowedImports.has(name))) {
    throw new Error(`The client entry has an unapproved import: ${imports.find((name) => !allowedImports.has(name))}`);
  }
  if (
    !entryText.includes('runtimeStatus !== "account-shell"') ||
    !entryText.includes("CLIENT_PRODUCT.defaultApiOrigin")
  ) {
    throw new Error("The client entry must use the closed account-shell role and fixed API origin.");
  }
  if (
    !viteText.includes(`resolve(CLIENT_MAIN_SOURCE)`) ||
    !viteText.includes("resolve(CLIENT_PRELOAD_ARTIFACT)") ||
    !viteText.includes('resolve("src/preload/client-index.ts")') ||
    !viteText.includes('resolve("src/renderer/client.html")') ||
    viteText.includes("src/main/index.ts") ||
    viteText.includes("src/preload/index.ts")
  ) {
    throw new Error("The client Vite configuration must build only its client main, preload and renderer entries.");
  }
}

async function verifyWindowsPackage(appPath: string, packageVersion: string) {
  const packageRoot = await requirePackageRoot(appPath, "Windows client package");
  const resources = await requirePackageDirectory(packageRoot, "resources", "Windows resource root");
  const executable = join(packageRoot, `${CLIENT_PRODUCT.executableName}.exe`);
  const archive = join(resources, "app.asar");
  await assertResourceAllowlist(
    resources,
    new Set(["app.asar", "app.asar.unpacked", "licenses"]),
    WINDOWS_RESOURCE_FILES,
  );
  await assertNoUpdateMetadata(resources);
  await verifyClientArchive(archive);
  const packagedManifest = clientManifestSchema.parse(JSON.parse(await readAsarFile(archive, "package.json")));
  assertManifest(packagedManifest, packageVersion);

  const versionInfo = windowsVersionSchema.parse(
    JSON.parse(
      runWindowsPowerShell(
        `$value = (Get-Item -LiteralPath '${powerShellLiteral(executable)}').VersionInfo; ` +
          "[pscustomobject]@{ ProductName = $value.ProductName; FileDescription = $value.FileDescription; ProductVersion = $value.ProductVersion } | ConvertTo-Json -Compress",
      ),
    ),
  );
  expectEqual(versionInfo.ProductName, CLIENT_PRODUCT.productName, "Windows product name");
  expectEqual(versionInfo.FileDescription, CLIENT_PRODUCT.productName, "Windows file description");
  if (!versionInfo.ProductVersion.startsWith(packageVersion)) {
    throw new Error(`Unexpected Windows product version: ${String(versionInfo.ProductVersion)}.`);
  }

  const files = await listRegularFiles(packageRoot);
  const nativeFiles = files.filter((path) => [".exe", ".dll", ".node", ".pyd"].includes(extname(path).toLowerCase()));
  if (!nativeFiles.includes(executable)) throw new Error("The client executable is absent from the ARM64 scan.");
  for (const path of nativeFiles) await assertWindowsArm64(path);
  return { nativeBinaryCount: nativeFiles.length };
}

async function verifyMacPackage(appPath: string, packageVersion: string) {
  const appRoot = await requirePackageRoot(appPath, "macOS client application");
  const contents = await requirePackageDirectory(appRoot, "Contents", "macOS Contents directory");
  const resources = await requirePackageDirectory(appRoot, join("Contents", "Resources"), "macOS resource root");
  const executable = join(contents, "MacOS", CLIENT_PRODUCT.executableName);
  const archive = join(resources, "app.asar");
  const files = await listMacBundleFiles(appRoot);
  await assertResourceAllowlist(
    resources,
    new Set([
      "app.asar",
      "app.asar.unpacked",
      "icon.icns",
      "LICENSE.electron.txt",
      "LICENSES.chromium.html",
      "licenses",
    ]),
    MAC_RESOURCE_FILES,
  );
  await assertNoUpdateMetadata(resources);
  await verifyClientArchive(archive);
  const packagedManifest = clientManifestSchema.parse(JSON.parse(await readAsarFile(archive, "package.json")));
  assertManifest(packagedManifest, packageVersion);

  const infoPlist = await resolveContainedFile(appRoot, join("Contents", "Info.plist"), "macOS Info.plist");
  const plist = macInfoSchema.parse(
    JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlist], {
        encoding: "utf8",
      }),
    ),
  );
  expectEqual(plist.CFBundleDisplayName, CLIENT_PRODUCT.productName, "macOS display name");
  expectEqual(plist.CFBundleExecutable, CLIENT_PRODUCT.executableName, "macOS executable name");
  expectEqual(plist.CFBundleIdentifier, CLIENT_PRODUCT.applicationId, "macOS bundle identifier");
  expectEqual(plist.CFBundleShortVersionString, packageVersion, "macOS bundle version");
  const schemes = plist.CFBundleURLTypes?.flatMap((entry) => entry.CFBundleURLSchemes ?? []) ?? [];
  if (schemes.length !== 1 || schemes[0] !== CLIENT_PRODUCT.protocolScheme) {
    throw new Error("The macOS bundle must register only the independent Feitu client URL scheme.");
  }

  let nativeBinaryCount = 0;
  for (const path of files) {
    if (!(await isMachO(path))) continue;
    await assertMacArm64(path);
    nativeBinaryCount += 1;
  }
  const executablePath = await resolveContainedFile(appRoot, relative(appRoot, executable), "macOS executable");
  if (!files.includes(executablePath) || nativeBinaryCount === 0) {
    throw new Error("The macOS application executable or its native helper graph is missing.");
  }
  return { nativeBinaryCount };
}

function assertClientArchive(entries: readonly string[]): void {
  for (const path of entries) {
    if (!CLIENT_PACKAGE_FILES.has(path)) throw new Error(`Unexpected packaged client file: ${path}`);
    if (FORBIDDEN_RESOURCE_NAMES.has(path.split("/").at(-1)?.toLowerCase() ?? "")) {
      throw new Error(`A Host runtime is present in the client archive: ${path}`);
    }
  }
  for (const required of CLIENT_PACKAGE_FILES) {
    if (!entries.includes(required)) throw new Error(`The client archive is missing ${required}.`);
  }
  for (const forbidden of [
    "out/main/index.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
    "out/main/application-services.js",
    "out/main/agent-database-host.js",
    "out/main/voice-transcription-host.js",
    "out/main/voice-speech-host.js",
  ]) {
    if (entries.includes(forbidden)) throw new Error(`The Host package entry is present: ${forbidden}`);
  }
}

export async function verifyClientArchive(archive: string): Promise<void> {
  const entries = await readAsarEntries(archive);
  assertClientArchive(entries);
}

function assertManifest(manifest: z.output<typeof clientManifestSchema>, packageVersion: string): void {
  expectEqual(manifest.name, "feitu-openbot-client", "packaged application name");
  expectEqual(manifest.productName, CLIENT_PRODUCT.productName, "packaged product name");
  expectEqual(manifest.main, CLIENT_MAIN_ARTIFACT, "packaged main entry");
  expectEqual(manifest.version, packageVersion, "packaged application version");
  expectEqual(manifest.feituClientRole, "client", "packaged product role");
  expectEqual(manifest.feituClientRuntimeStatus, "account-shell", "packaged runtime status");
  expectEqual(manifest.feituClientApplicationId, CLIENT_PRODUCT.applicationId, "packaged application ID");
  expectEqual(manifest.feituClientProtocolScheme, CLIENT_PRODUCT.protocolScheme, "packaged URL scheme");
  expectEqual(manifest.feituClientDefaultApiOrigin, CLIENT_PRODUCT.defaultApiOrigin, "default account API");
  expectEqual(manifest.feituClientDefaultConnectOrigin, CLIENT_PRODUCT.defaultConnectOrigin, "default connect origin");
  expectEqual(manifest.feituClientUpdateChannel, CLIENT_PRODUCT.updateChannel, "independent update channel name");
  expectEqual(manifest.feituClientUpdateFeed, null, "packaged update feed");
}

async function assertResourceAllowlist(
  resources: string,
  allowedTopLevel: ReadonlySet<string>,
  allowedFiles: ReadonlySet<string>,
): Promise<void> {
  await assertNoResourceSymlinks(resources);
  const names = await readdir(resources);
  for (const name of names) {
    if (!allowedTopLevel.has(name)) throw new Error(`Unexpected client resource: ${join(resources, name)}`);
    if (name === "app.asar.unpacked") {
      const unpacked = await readdir(join(resources, name));
      if (unpacked.length > 0) throw new Error(`The client has unpacked runtime dependencies: ${unpacked.join(", ")}`);
    }
    if (FORBIDDEN_RESOURCE_NAMES.has(name.toLowerCase())) {
      throw new Error(`A Host resource is present in the client package: ${name}`);
    }
  }
  const packagedFiles = new Set<string>();
  for (const path of await listRegularFiles(resources)) {
    const name = relative(resources, path).split(sep).join("/");
    if (!allowedFiles.has(name)) throw new Error(`Unexpected client resource file: ${name}`);
    packagedFiles.add(name);
  }
  for (const name of allowedFiles) {
    if (!packagedFiles.has(name)) throw new Error(`The packaged client resource is missing ${name}.`);
  }
}

export async function assertNoResourceSymlinks(directory: string): Promise<void> {
  const rootMetadata = await lstat(directory);
  if (rootMetadata.isSymbolicLink()) throw new Error(`The client resource root is a symbolic link: ${directory}`);
  if (!rootMetadata.isDirectory()) throw new Error(`The client resource root is not a directory: ${directory}`);

  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`The client resource is a symbolic link: ${path}`);
    if (metadata.isDirectory()) await assertNoResourceSymlinks(path);
  }
}

async function assertNoUpdateMetadata(resources: string): Promise<void> {
  try {
    await access(join(resources, "app-update.yml"));
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  throw new Error("The client must not contain update metadata until its independent feed is configured.");
}

async function assertWindowsArm64(path: string): Promise<void> {
  const file = await readFile(path);
  if (file.toString("ascii", 0, 2) !== "MZ") throw new Error(`${path} is not a PE binary.`);
  const peOffset = file.readUInt32LE(0x3c);
  if (peOffset > file.length - 6 || file.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`${path} has an invalid PE header.`);
  }
  const machine = file.readUInt16LE(peOffset + 4);
  if (machine !== WINDOWS_ARM64_MACHINE) {
    throw new Error(`Expected native Windows ARM64 in ${path}; PE machine is 0x${machine.toString(16)}.`);
  }
}

async function assertMacArm64(path: string): Promise<void> {
  const architectures = execFileSync("lipo", ["-archs", path], { encoding: "utf8" })
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`Expected an arm64-only Mach-O binary in ${path}; found ${architectures.join(", ") || "none"}.`);
  }
}

async function isMachO(path: string): Promise<boolean> {
  const file = await readFile(path);
  if (file.length < 4) return false;
  const magic = file.toString("hex", 0, 4);
  return MACH_O_MAGICS.has(magic);
}

async function readAsarEntries(archive: string): Promise<string[]> {
  const buffer = await readFile(archive);
  const { header } = parseAsarHeader(buffer, archive);
  const entries: string[] = [];
  collectAsarEntries(header.files, "", entries);
  return entries.sort();
}

function parseAsarHeader(
  buffer: Buffer,
  archive: string,
): { header: z.output<typeof asarHeaderSchema>; headerSize: number } {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 4) throw new Error(`${archive} has no valid ASAR header.`);

  const headerSize = buffer.readUInt32LE(4);
  const headerJsonLength = buffer.readUInt32LE(12);
  const headerDataEnd = 8 + headerSize;
  const headerJsonEnd = 16 + headerJsonLength;
  if (headerDataEnd > buffer.length || headerJsonEnd > headerDataEnd || headerJsonLength === 0) {
    throw new Error(`${archive} has an invalid ASAR header size.`);
  }

  const header = asarHeaderSchema.parse(JSON.parse(buffer.toString("utf8", 16, headerJsonEnd)));
  return { header, headerSize };
}

function collectAsarEntries(files: AsarDirectory, prefix: string, entries: string[]): void {
  for (const [name, entry] of Object.entries(files)) {
    validateAsarMemberSegment(name);
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.link !== undefined) throw new Error(`ASAR link entries are forbidden in the client archive: ${path}`);
    if (entry.unpacked) throw new Error(`The client ASAR contains an unpacked entry: ${path}`);
    if (entry.files !== undefined) {
      if (entry.offset !== undefined || entry.size !== undefined) {
        throw new Error(`The client ASAR has a directory with file metadata: ${path}`);
      }
      collectAsarEntries(entry.files, path, entries);
    } else {
      if (
        entry.size === undefined ||
        (!entry.unpacked && entry.offset === undefined) ||
        (entry.unpacked && entry.offset !== undefined)
      ) {
        throw new Error(`The client ASAR has an invalid file entry: ${path}`);
      }
      entries.push(path);
    }
  }
}

function validateAsarMemberSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    segment.includes(":") ||
    isAbsolute(segment) ||
    win32.isAbsolute(segment)
  ) {
    throw new Error(`The client ASAR has an invalid member path segment: ${JSON.stringify(segment)}.`);
  }
}

async function readAsarFile(archive: string, name: string): Promise<string> {
  const buffer = await readFile(archive);
  const { header, headerSize } = parseAsarHeader(buffer, archive);
  const entries: string[] = [];
  collectAsarEntries(header.files, "", entries);
  const entry = asarEntry(header.files, name.split("/"));
  if (
    !entry ||
    entry.files !== undefined ||
    entry.link !== undefined ||
    entry.unpacked ||
    entry.offset === undefined ||
    entry.size === undefined
  ) {
    throw new Error(`${archive} does not contain ${name}.`);
  }
  const offset = Number(entry.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`${archive} has an invalid offset for ${name}.`);
  const start = 8 + headerSize + offset;
  if (start < 0 || start + entry.size > buffer.length) throw new Error(`${archive} has an invalid offset for ${name}.`);
  return buffer.toString("utf8", start, start + entry.size);
}

function asarEntry(files: AsarDirectory, path: string[]): AsarEntry | undefined {
  const [name, ...rest] = path;
  if (!name) return undefined;
  const entry = files[name];
  if (!rest.length) return entry;
  if (!entry?.files) return undefined;
  return asarEntry(entry.files, rest);
}

async function requirePackageRoot(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`The ${label} root is a symbolic link: ${path}`);
  if (!metadata.isDirectory()) throw new Error(`The ${label} root is not a directory: ${path}`);
  return realpath(path);
}

async function requirePackageDirectory(root: string, relativePath: string, label: string): Promise<string> {
  const segments = relativePath.split(sep);
  let currentPath = root;
  for (const segment of segments) {
    const path = join(currentPath, segment);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`The ${label} is a symbolic link: ${path}`);
    if (!metadata.isDirectory()) throw new Error(`The ${label} is not a directory: ${path}`);
    const canonicalPath = await realpath(path);
    if (!isWithinDirectory(root, canonicalPath)) {
      throw new Error(`The ${label} escapes the client package root: ${path}`);
    }
    currentPath = canonicalPath;
  }
  return currentPath;
}

async function resolveContainedFile(root: string, relativePath: string, label: string): Promise<string> {
  const path = join(root, relativePath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    throw new Error(`The ${label} cannot be resolved inside the client package: ${path}`);
  }
  if (!isWithinDirectory(root, canonicalPath)) {
    throw new Error(`The ${label} escapes the client package root: ${path}`);
  }
  const metadata = await lstat(canonicalPath);
  if (!metadata.isFile()) throw new Error(`The ${label} is not a file: ${path}`);
  return canonicalPath;
}

function isWithinDirectory(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

async function listRegularFiles(root: string): Promise<string[]> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink()) throw new Error(`The client package directory is a symbolic link: ${root}`);
  if (!rootMetadata.isDirectory()) throw new Error(`The client package path is not a directory: ${root}`);

  const files: string[] = [];
  await visit(root);
  return files;

  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`The client package contains a symbolic link: ${path}`);
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error(`The client package contains an unsupported file type: ${path}`);
    }
  }
}

export async function listMacBundleFiles(appPath: string): Promise<string[]> {
  const root = await requirePackageRoot(appPath, "macOS client application");
  const files: string[] = [];
  const visitedDirectories = new Set<string>();
  const activeDirectories = new Set<string>();
  const visitedFiles = new Set<string>();

  await visit(root);
  return files.sort();

  async function visit(path: string): Promise<void> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
    } catch {
      throw new Error(`The macOS client bundle contains an unresolved link: ${path}`);
    }
    if (!isWithinDirectory(root, canonicalPath)) {
      throw new Error(`The macOS client bundle link escapes its app root: ${path}`);
    }

    const metadata = await lstat(canonicalPath);
    if (metadata.isDirectory()) {
      if (activeDirectories.has(canonicalPath)) {
        throw new Error(`The macOS client bundle contains a directory link cycle: ${path}`);
      }
      if (visitedDirectories.has(canonicalPath)) return;

      visitedDirectories.add(canonicalPath);
      activeDirectories.add(canonicalPath);
      try {
        for (const name of await readdir(canonicalPath)) await visit(join(canonicalPath, name));
      } finally {
        activeDirectories.delete(canonicalPath);
      }
    } else if (metadata.isFile()) {
      if (!visitedFiles.has(canonicalPath)) {
        visitedFiles.add(canonicalPath);
        files.push(canonicalPath);
      }
    } else {
      throw new Error(`The macOS client bundle contains an unsupported file type: ${path}`);
    }
  }
}

function defaultArtifactPath() {
  return process.platform === "win32"
    ? "dist/client/win-arm64-unpacked"
    : "dist/client/mac-arm64/FeituOpenBotClient.app";
}

async function readWorkspaceVersion(): Promise<string> {
  return packageVersionSchema.parse(JSON.parse(await readFile("package.json", "utf8"))).version;
}

function expectEqual<Value>(actual: Value, expected: NoInfer<Value>, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)}).`);
  }
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function runWindowsPowerShell(command: string): string {
  const environment = { ...process.env };
  delete environment.PSModulePath;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: environment,
  });
}

if (import.meta.main) await main();
