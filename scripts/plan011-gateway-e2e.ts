import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/auth-api");
const e2ePath = resolve(packageDirectory, "scripts/plan011-gateway-e2e.ts");
const task = "plan011-phase2-self-hosted-auth-http";
const environmentToClear = [
  "OPENBOT_SELF_HOSTED_HOST",
  "OPENBOT_SELF_HOSTED_PORT",
  "OPENBOT_SELF_HOSTED_DATABASE_PATH",
  "OPENBOT_SELF_HOSTED_MODE",
  "OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE",
  "OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK",
  "OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS",
  "OPENBOT_SELF_HOSTED_TICKET_KEY_ID",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USERNAME",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_FROM",
  "EMAIL_LICENSE_FROM",
  "EMAIL_RELAY",
  "EMAIL_DELIVERY_WEBHOOK_URL",
  "EMAIL_DELIVERY_WEBHOOK_SECRET",
  "AUTH_EXPOSE_DEVELOPMENT_CODE",
  "REMOTE_TICKET_PRIVATE_JWK",
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_TICKET_KEY_ID",
] as const;

if (process.versions.bun) {
  process.stderr.write(`{"task":"${task}","result":"requires-native-node"}\n`);
  process.exitCode = 1;
} else {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of environmentToClear) delete childEnvironment[name];
  const child = spawn(process.execPath, ["--import", "tsx", e2ePath], {
    cwd: packageDirectory,
    env: childEnvironment,
    stdio: "inherit",
  });
  let timedOut = false;
  let forceKill: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`{"task":"${task}","result":"timeout"}\n`);
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 12_000);
    forceKill.unref();
  }, 60_000);
  timeout.unref();

  child.once("error", () => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    process.stderr.write(`{"task":"${task}","result":"failed-to-start"}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    process.exitCode = timedOut ? 1 : (code ?? 1);
  });
}
