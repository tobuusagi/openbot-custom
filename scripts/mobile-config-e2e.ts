// Resolves the real Expo config in a fresh process. It checks the released defaults and the
// isolated Feitu Android config, including missing or mismatched Firebase files.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const APP_DIRECTORY = resolve(import.meta.dirname, "../apps/mobile");
const REPORT_DIRECTORY = resolve(import.meta.dirname, "../.openbot-build/mobile-config-e2e");
const REPORT_PATH = join(REPORT_DIRECTORY, "report.json");
const FEITU_VARIANT = "feitu-android";
const FEITU_PACKAGE = "cn.net.feitu.openbot.client";
const FEITU_API_ORIGIN = "https://api.feitu.net.cn";
const FEITU_SCHEME = "feitu-openbot";
const RELEASED_SCHEME = "openbot";

const ExpoConfigSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  scheme: z.union([z.string(), z.array(z.string())]).optional(),
  owner: z.string().optional(),
  android: z
    .object({
      package: z.string().optional(),
      googleServicesFile: z.string().optional(),
    })
    .optional(),
  ios: z.object({ bundleIdentifier: z.string().optional() }).optional(),
  extra: z
    .object({
      eas: z.object({ projectId: z.string().optional() }).optional(),
      openbotMobileProduct: z
        .object({
          variant: z.string().optional(),
          defaultAccountApiUrl: z.string().optional(),
          androidFcmConfigured: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  updates: z
    .object({
      enabled: z.boolean().optional(),
      checkAutomatically: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});
const AppJsonSchema = z.object({ expo: ExpoConfigSchema });
type ExpoConfig = z.infer<typeof ExpoConfigSchema>;
type Check = { name: string; passed: boolean; detail?: string | boolean | number };

const checks: Check[] = [];

function addCheck(name: string, passed: boolean, detail?: Check["detail"]): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

function expoConfig(environment: Record<string, string | undefined>): {
  status: number;
  output: string;
  config: ExpoConfig | null;
} {
  const env = { ...process.env };
  delete env.OPENBOT_MOBILE_VARIANT;
  delete env.EAS_BUILD_PLATFORM;
  delete env.OPENBOT_FEITU_GOOGLE_SERVICES_FILE;
  env.EXPO_NO_TELEMETRY = "1";
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  const result = spawnSync(process.execPath, ["x", "expo", "config", "--json"], {
    cwd: APP_DIRECTORY,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) return { status: result.status ?? 1, output, config: null };
  if (result.status !== 0) return { status: result.status ?? 1, output, config: null };

  const start = result.stdout.indexOf("{");
  if (start < 0) return { status: 1, output, config: null };
  try {
    const parsed = ExpoConfigSchema.safeParse(JSON.parse(result.stdout.slice(start)));
    return parsed.success ? { status: 0, output, config: parsed.data } : { status: 1, output, config: null };
  } catch {
    return { status: 1, output, config: null };
  }
}

function writeFirebaseFixture(directory: string, filename: string, packageName: string): string {
  const file = join(directory, filename);
  writeFileSync(
    file,
    JSON.stringify({
      client: [{ client_info: { android_client_info: { package_name: packageName } } }],
    }),
  );
  return `./${relative(APP_DIRECTORY, file).split(sep).join("/")}`;
}

function assertSuccessfulConfig(name: string, result: ReturnType<typeof expoConfig>): ExpoConfig | null {
  addCheck(`${name} resolves`, result.status === 0 && result.config !== null, result.status);
  return result.config;
}

function hasExpectedProductIdentity(config: ExpoConfig, withFirebase: boolean): boolean {
  const android = config.android ?? {};
  const product = config.extra?.openbotMobileProduct ?? {};
  const eas = config.extra?.eas ?? {};
  const updates = config.updates ?? {};
  const scheme = config.scheme;
  const schemes = Array.isArray(scheme) ? scheme : [scheme];
  return (
    config.name === "FeituOpenBotClient" &&
    config.slug === "feitu-openbot-client" &&
    schemes.length === 1 &&
    schemes[0] === FEITU_SCHEME &&
    android.package === FEITU_PACKAGE &&
    config.owner === undefined &&
    eas.projectId === undefined &&
    updates.enabled === false &&
    updates.checkAutomatically === "NEVER" &&
    updates.url === undefined &&
    product.variant === FEITU_VARIANT &&
    product.defaultAccountApiUrl === FEITU_API_ORIGIN &&
    product.androidFcmConfigured === withFirebase
  );
}

function main(): void {
  const appJson = AppJsonSchema.parse(JSON.parse(readFileSync(join(APP_DIRECTORY, "app.json"), "utf8")));
  const released = appJson.expo;
  const scratchRoot = join(APP_DIRECTORY, ".openbot-build");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "mobile-config-e2e-"));

  try {
    const defaultResult = expoConfig({});
    const defaultConfig = assertSuccessfulConfig("released default", defaultResult);
    if (defaultConfig) {
      const defaultAndroid = defaultConfig.android ?? {};
      const defaultIos = defaultConfig.ios ?? {};
      const releasedAndroid = released.android ?? {};
      const releasedIos = released.ios ?? {};
      const defaultEas = defaultConfig.extra?.eas ?? {};
      const releasedEas = released.extra?.eas ?? {};
      const defaultUpdates = defaultConfig.updates ?? {};
      const releasedUpdates = released.updates ?? {};
      addCheck(
        "released identity and update settings match app.json",
        defaultConfig.name === released.name &&
          defaultConfig.slug === released.slug &&
          defaultConfig.scheme === RELEASED_SCHEME &&
          defaultConfig.scheme === released.scheme &&
          defaultAndroid.package === releasedAndroid.package &&
          defaultIos.bundleIdentifier === releasedIos.bundleIdentifier &&
          defaultConfig.owner === released.owner &&
          defaultEas.projectId === releasedEas.projectId &&
          defaultUpdates.url === releasedUpdates.url,
      );
      const expectedReleasedGoogleServices = existsSync(join(APP_DIRECTORY, "google-services.json"))
        ? "./google-services.json"
        : undefined;
      addCheck(
        "released Firebase selection is unchanged",
        defaultConfig.android?.googleServicesFile === expectedReleasedGoogleServices,
      );
    }

    const syntheticFirebasePath = writeFirebaseFixture(scratch, "google-services.feitu.json", FEITU_PACKAGE);
    const variantResult = expoConfig({
      OPENBOT_MOBILE_VARIANT: FEITU_VARIANT,
      EAS_BUILD_PLATFORM: "android",
      OPENBOT_FEITU_GOOGLE_SERVICES_FILE: syntheticFirebasePath,
    });
    const variantConfig = assertSuccessfulConfig("Feitu Android variant", variantResult);
    if (variantConfig) {
      addCheck("Feitu identity and OTA isolation", hasExpectedProductIdentity(variantConfig, true));
      addCheck(
        "Feitu Firebase file is separate and matches its package",
        variantConfig.android?.googleServicesFile === syntheticFirebasePath &&
          variantConfig.android.googleServicesFile !== "./google-services.json",
      );
    }

    const missingFirebasePath = `./.openbot-build/mobile-config-e2e-missing-${process.pid}.json`;
    const noFirebaseResult = expoConfig({
      OPENBOT_MOBILE_VARIANT: FEITU_VARIANT,
      EAS_BUILD_PLATFORM: "android",
      OPENBOT_FEITU_GOOGLE_SERVICES_FILE: missingFirebasePath,
    });
    const noFirebaseConfig = assertSuccessfulConfig("Feitu Android without Firebase", noFirebaseResult);
    if (noFirebaseConfig) {
      addCheck("Feitu push is disabled without Firebase", hasExpectedProductIdentity(noFirebaseConfig, false));
      addCheck("released Firebase config is not inherited", noFirebaseConfig.android?.googleServicesFile === undefined);
    }

    const wrongFirebasePath = writeFirebaseFixture(scratch, "google-services.wrong.json", "run.openbot.mobile");
    const wrongFirebase = expoConfig({
      OPENBOT_MOBILE_VARIANT: FEITU_VARIANT,
      EAS_BUILD_PLATFORM: "android",
      OPENBOT_FEITU_GOOGLE_SERVICES_FILE: wrongFirebasePath,
    });
    addCheck(
      "Firebase config for another package is rejected",
      wrongFirebase.status !== 0 && wrongFirebase.output.includes("invalid for cn.net.feitu.openbot.client"),
    );

    const invalidVariant = expoConfig({
      OPENBOT_MOBILE_VARIANT: "unknown",
      EAS_BUILD_PLATFORM: "android",
    });
    addCheck(
      "unsupported mobile variant is rejected",
      invalidVariant.status !== 0 && invalidVariant.output.includes("Unsupported OpenBot mobile variant."),
    );

    const iosVariant = expoConfig({
      OPENBOT_MOBILE_VARIANT: FEITU_VARIANT,
      EAS_BUILD_PLATFORM: "ios",
    });
    addCheck(
      "Feitu Android variant is rejected for iOS",
      iosVariant.status !== 0 && iosVariant.output.includes("requires EAS_BUILD_PLATFORM=android"),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  mkdirSync(REPORT_DIRECTORY, { recursive: true });
  const failed = checks.filter((check) => !check.passed);
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: "bun x expo config --json",
        firebaseFixture: "synthetic package-name-only config; no Firebase project or credentials",
        checks,
        passed: failed.length === 0,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `Mobile config E2E: ${checks.length - failed.length}/${checks.length} passed. Report: ${REPORT_PATH}\n`,
  );
  if (failed.length > 0) {
    process.stderr.write(
      `${failed.map(({ name, detail }) => `${name}${detail === undefined ? "" : ` (${detail})`}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}

main();
