import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Effect } from "effect";
import { readSelfHostedConfig, readSelfHostedSmtpConfiguration } from "../src/self-hosted/config";
import {
  readSelfHostedSystemdCredentials,
  SELF_HOSTED_SYSTEMD_CREDENTIALS,
  SelfHostedSystemdCredentialsError,
} from "../src/self-hosted/systemd-credentials";

const reportPath = join(process.cwd(), "../../.openbot-build/systemd-credentials-e2e.json");
const secretSentinel = "fixture-only-secret-sentinel";
const validValues = {
  OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK: `{"kty":"EC","d":"${secretSentinel}"}`,
  OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS: '{"keys":[]}',
  OPENBOT_SELF_HOSTED_TICKET_KEY_ID: "fixture-key",
  EMAIL_SMTP_HOST: "smtp.example.invalid",
  EMAIL_SMTP_PORT: "465",
  EMAIL_SMTP_USERNAME: "sender@example.invalid",
  EMAIL_SMTP_PASSWORD: secretSentinel,
  EMAIL_FROM: "sender@example.invalid",
} as const;

const root = await mkdtemp(join(tmpdir(), "systemd-credentials-e2e-"));
const credentials = join(root, "credentials");
await mkdir(credentials);
let result: "passed" | "failed" = "failed";
let failure: string | undefined;
try {
  for (const name of SELF_HOSTED_SYSTEMD_CREDENTIALS) {
    await writeFile(join(credentials, name), validValues[name], { mode: 0o600 });
  }
  const loaded = await Effect.runPromise(readSelfHostedSystemdCredentials(credentials));
  assert.deepEqual(loaded, validValues);
  const runtime = readSelfHostedConfig({
    OPENBOT_SELF_HOSTED_SYSTEMD_CREDENTIALS: "true",
    OPENBOT_SELF_HOSTED_MODE: "production",
    ...loaded,
  });
  assert.equal(runtime.mode, "production");
  assert.equal(runtime.exposeDevelopmentCode, false);
  assert.equal(readSelfHostedSmtpConfiguration(loaded).status, "configured");

  await rm(join(credentials, "EMAIL_FROM"));
  await expectSafeFailure(credentials, "credential_missing", "EMAIL_FROM");
  await writeFile(join(credentials, "EMAIL_FROM"), `${secretSentinel}\n${secretSentinel}`);
  await expectSafeFailure(credentials, "credential_value_invalid", "EMAIL_FROM");
  await writeFile(join(root, "outside"), secretSentinel);
  await rm(join(credentials, "EMAIL_FROM"));
  await symlink(join(root, "outside"), join(credentials, "EMAIL_FROM"));
  await expectSafeFailure(credentials, "credential_file_invalid", "EMAIL_FROM");
  await rm(join(credentials, "EMAIL_FROM"));
  await writeFile(join(credentials, "EMAIL_FROM"), "x".repeat(16 * 1024 + 1));
  await expectSafeFailure(credentials, "credential_file_invalid", "EMAIL_FROM");
  await writeFile(join(credentials, "EMAIL_FROM"), Buffer.from([0xff]));
  await expectSafeFailure(credentials, "credential_file_invalid", "EMAIL_FROM");
  await writeFile(join(credentials, "EMAIL_FROM"), validValues.EMAIL_FROM);
  await writeFile(join(credentials, "UNLISTED"), secretSentinel);
  assert.deepEqual(await Effect.runPromise(readSelfHostedSystemdCredentials(credentials)), validValues);
  result = "passed";
} catch (cause) {
  failure = cause instanceof Error ? cause.message : "Unknown fixture failure.";
  process.exitCode = 1;
} finally {
  await mkdir(join(process.cwd(), "../../.openbot-build"), { recursive: true });
  const report = { task: "systemd-credentials-e2e", result, checks: SELF_HOSTED_SYSTEMD_CREDENTIALS.length, failure };
  const { writeFile: writeReport } = await import("node:fs/promises");
  await writeReport(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ task: "systemd-credentials-e2e", result })}\n`);

async function expectSafeFailure(directory: string, code: string, credential: string): Promise<void> {
  try {
    await Effect.runPromise(readSelfHostedSystemdCredentials(directory));
    assert.fail("Credential input must be rejected.");
  } catch (cause) {
    assert(cause instanceof SelfHostedSystemdCredentialsError);
    assert.equal(cause.code, code);
    assert.equal(cause.credential, credential);
    assert(!JSON.stringify(cause).includes(secretSentinel));
  }
}
