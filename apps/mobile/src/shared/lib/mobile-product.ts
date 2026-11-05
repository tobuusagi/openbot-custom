import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import * as Application from "expo-application";
import Constants from "expo-constants";

const FEITU_ANDROID_PACKAGE = "cn.net.feitu.openbot.client";
const FEITU_ANDROID_VARIANT = "feitu-android";
const FEITU_ACCOUNT_API_ORIGIN = "https://api.feitu.net.cn";

function mobileProductMetadata() {
  const extra = Constants.expoConfig?.extra;
  return isDynamicRecord(extra) && isDynamicRecord(extra.openbotMobileProduct) ? extra.openbotMobileProduct : null;
}

/** True for the Feitu product, including when its embedded Expo metadata is missing. */
export function isFeituAndroidClient(): boolean {
  return (
    Application.applicationId === FEITU_ANDROID_PACKAGE || mobileProductMetadata()?.variant === FEITU_ANDROID_VARIANT
  );
}

/** The Feitu email sign-in endpoint, or null when its embedded product config is missing or invalid. */
export function feituAndroidAccountApiUrl(): string | null {
  const metadata = mobileProductMetadata();
  return isFeituAndroidClient() &&
    metadata?.variant === FEITU_ANDROID_VARIANT &&
    metadata.defaultAccountApiUrl === FEITU_ACCOUNT_API_ORIGIN
    ? FEITU_ACCOUNT_API_ORIGIN
    : null;
}

/** Whether this product has a Firebase config for its own Android application ID. */
export function feituAndroidPushConfigured(): boolean {
  if (!isFeituAndroidClient()) return true;
  const metadata = mobileProductMetadata();
  return metadata?.variant === FEITU_ANDROID_VARIANT && metadata.androidFcmConfigured === true;
}

/** Keep the released link payload and parser unchanged while accepting the Feitu app's own scheme. */
export function canonicalMobileProductLink(value: string): string {
  return isFeituAndroidClient() ? value.replace(/^feitu-openbot:/iu, "openbot:") : value;
}
