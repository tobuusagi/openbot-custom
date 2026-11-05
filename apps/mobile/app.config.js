const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { isAbsolute, relative, resolve, sep } = require("node:path");

// Android notifications use Firebase Cloud Messaging. The file is optional for the released app, so
// it can build before Firebase exists. It contains public identifiers only; a trusted sender holds
// the service-account key.
const GOOGLE_SERVICES_FILE = "./google-services.json";
const FEITU_ANDROID_GOOGLE_SERVICES_FILE = "./google-services.feitu.json";
const FEITU_ANDROID_VARIANT = "feitu-android";
const FEITU_ANDROID_PACKAGE = "cn.net.feitu.openbot.client";
const FEITU_ACCOUNT_API_ORIGIN = "https://api.feitu.net.cn";

/** @param {{ config: import('expo/config').ExpoConfig }} context */
module.exports = ({ config }) => {
  const variant = process.env.OPENBOT_MOBILE_VARIANT;
  if (!variant) return withReleasedGoogleServices(config);
  if (variant !== FEITU_ANDROID_VARIANT) {
    throw new Error("Unsupported OpenBot mobile variant.");
  }
  if (process.env.EAS_BUILD_PLATFORM !== "android") {
    throw new Error("The Feitu Android variant requires EAS_BUILD_PLATFORM=android.");
  }

  return withFeituAndroidVariant(config);
};

function withReleasedGoogleServices(config) {
  return existsSync(resolve(__dirname, GOOGLE_SERVICES_FILE))
    ? {
        ...config,
        android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE },
      }
    : config;
}

function withFeituAndroidVariant(config) {
  const googleServicesFile = feituGoogleServicesFile();
  const fullGoogleServicesPath = resolve(__dirname, googleServicesFile);
  const androidFcmConfigured = existsSync(fullGoogleServicesPath);
  if (resolve(fullGoogleServicesPath) === resolve(__dirname, GOOGLE_SERVICES_FILE)) {
    throw new Error("The Feitu Firebase config must use a separate file from the released app.");
  }
  if (androidFcmConfigured) {
    const releasedGoogleServicesPath = resolve(__dirname, GOOGLE_SERVICES_FILE);
    if (
      existsSync(releasedGoogleServicesPath) &&
      realpathSync(fullGoogleServicesPath) === realpathSync(releasedGoogleServicesPath)
    ) {
      throw new Error("The Feitu Firebase config must use a separate file from the released app.");
    }
    validateFeituGoogleServices(fullGoogleServicesPath);
  }

  const android = { ...config.android, package: FEITU_ANDROID_PACKAGE };
  // Never inherit the released app's Firebase config. A Feitu config is optional until its Firebase
  // project exists, but if present it must belong to this package.
  delete android.googleServicesFile;
  if (androidFcmConfigured) android.googleServicesFile = googleServicesFile;

  const extra = { ...(config.extra ?? {}) };
  if (isRecord(extra.eas)) {
    const eas = { ...extra.eas };
    delete eas.projectId;
    if (Object.keys(eas).length > 0) extra.eas = eas;
    else delete extra.eas;
  }
  extra.openbotMobileProduct = {
    variant: FEITU_ANDROID_VARIANT,
    defaultAccountApiUrl: FEITU_ACCOUNT_API_ORIGIN,
    androidFcmConfigured,
  };

  const updates = { ...(config.updates ?? {}), enabled: false, checkAutomatically: "NEVER" };
  delete updates.url;

  const variantConfig = {
    ...config,
    name: "FeituOpenBotClient",
    slug: "feitu-openbot-client",
    scheme: "feitu-openbot",
    android,
    extra,
    updates,
  };
  // Keep this product outside the released Expo project and its OTA update identity.
  delete variantConfig.owner;
  return variantConfig;
}

function feituGoogleServicesFile() {
  const file = process.env.OPENBOT_FEITU_GOOGLE_SERVICES_FILE ?? FEITU_ANDROID_GOOGLE_SERVICES_FILE;
  if (!file || isAbsolute(file)) {
    throw new Error("The Feitu Firebase config path must be relative to apps/mobile.");
  }
  const fullPath = resolve(__dirname, file);
  const pathFromApp = relative(__dirname, fullPath);
  if (pathFromApp === ".." || pathFromApp.startsWith(`..${sep}`)) {
    throw new Error("The Feitu Firebase config path must be relative to apps/mobile.");
  }
  return file;
}

function validateFeituGoogleServices(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("The Feitu Firebase config is invalid for cn.net.feitu.openbot.client.");
  }
  const matches =
    Array.isArray(config?.client) &&
    config.client.some((client) => client?.client_info?.android_client_info?.package_name === FEITU_ANDROID_PACKAGE);
  if (!matches) throw new Error("The Feitu Firebase config is invalid for cn.net.feitu.openbot.client.");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
