import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidHostname, normalizeEmailAddress } from "@openbot/contracts/validation";
import type { SmtpEmailConfig } from "../server/smtp-email-delivery";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3187;
const DEFAULT_DATABASE_PATH_VALUE = ".openbot-build/011-self-hosted/account.sqlite";
const DEFAULT_MODE = "production";
const DEFAULT_EXPOSE_DEVELOPMENT_CODE = "false";
const DEFAULT_DATABASE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.openbot-build/011-self-hosted/account.sqlite",
);

export const SELF_HOSTED_CONFIG_VARIABLES = [
  {
    name: "OPENBOT_SELF_HOSTED_HOST",
    defaultValue: DEFAULT_HOST,
    secret: false,
    purpose: "Loopback listener address.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_PORT",
    defaultValue: String(DEFAULT_PORT),
    secret: false,
    purpose: "HTTP listener port; zero selects an available port for local process checks.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_DATABASE_PATH",
    defaultValue: DEFAULT_DATABASE_PATH_VALUE,
    secret: false,
    purpose: "Local SQLite file path. Existing files are opened without applying migrations.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_MODE",
    defaultValue: DEFAULT_MODE,
    secret: false,
    purpose: "Local auth mode. Development-only code exposure requires development mode and loopback.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE",
    defaultValue: DEFAULT_EXPOSE_DEVELOPMENT_CODE,
    secret: false,
    purpose: "Return the local sign-in code only when development mode and loopback are both active.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK",
    defaultValue: undefined,
    secret: true,
    purpose: "Local remote-ticket signing key. The private/public pair is checked before readiness.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS",
    defaultValue: undefined,
    secret: false,
    purpose: "Public remote-ticket keys served by the JWKS endpoint.",
  },
  {
    name: "OPENBOT_SELF_HOSTED_TICKET_KEY_ID",
    defaultValue: undefined,
    secret: false,
    purpose: "Active key ID in the remote-ticket JWKS.",
  },
  {
    name: "EMAIL_SMTP_HOST",
    defaultValue: undefined,
    secret: false,
    purpose: "SMTP server host for email-code delivery. The connection uses implicit TLS.",
  },
  {
    name: "EMAIL_SMTP_PORT",
    defaultValue: undefined,
    secret: false,
    purpose: "SMTP port. Email-code delivery requires port 465 with implicit TLS.",
  },
  {
    name: "EMAIL_SMTP_USERNAME",
    defaultValue: undefined,
    secret: false,
    purpose: "SMTP login address.",
  },
  {
    name: "EMAIL_SMTP_PASSWORD",
    defaultValue: undefined,
    secret: true,
    purpose: "SMTP app password.",
  },
  {
    name: "EMAIL_FROM",
    defaultValue: undefined,
    secret: false,
    purpose: "From address for email-code delivery.",
  },
] as const;

const SELF_HOSTED_SMTP_VARIABLES = [
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USERNAME",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_FROM",
] as const;

export type SelfHostedSmtpConfiguration =
  | { status: "not_configured" }
  | { status: "invalid"; variables: readonly string[] }
  | { status: "configured"; config: SelfHostedSmtpConfig };

export type SelfHostedSmtpConfig = Omit<SmtpEmailConfig, "relay">;

export interface SelfHostedConfig {
  host: string;
  port: number;
  databasePath: string;
  mode: "development" | "production";
  exposeDevelopmentCode: boolean;
  remoteTicketPrivateJwk?: string;
  remoteTicketPublicJwks?: string;
  remoteTicketKeyId?: string;
}

export class SelfHostedConfigError extends Error {
  constructor(readonly variables: readonly string[]) {
    super("Self-hosted account runtime configuration is invalid.");
    this.name = "SelfHostedConfigError";
  }
}

/** Parse only the local runtime's variables. No dotenv file or account secret is loaded here. */
export function readSelfHostedConfig(
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory = process.cwd(),
): SelfHostedConfig {
  const invalid: string[] = [];
  const host = environment.OPENBOT_SELF_HOSTED_HOST?.trim() || DEFAULT_HOST;
  const rawPort = environment.OPENBOT_SELF_HOSTED_PORT?.trim() || String(DEFAULT_PORT);
  const configuredDatabasePath = environment.OPENBOT_SELF_HOSTED_DATABASE_PATH?.trim();
  const rawDatabasePath = configuredDatabasePath || DEFAULT_DATABASE_PATH_VALUE;
  const rawMode = environment.OPENBOT_SELF_HOSTED_MODE?.trim() || DEFAULT_MODE;
  const rawExposeDevelopmentCode =
    environment.OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE?.trim() || DEFAULT_EXPOSE_DEVELOPMENT_CODE;
  const port = Number(rawPort);

  if (!isLoopbackHost(host)) invalid.push("OPENBOT_SELF_HOSTED_HOST");
  if (!/^(?:0|[1-9]\d{0,4})$/u.test(rawPort) || !Number.isInteger(port) || port > 65_535) {
    invalid.push("OPENBOT_SELF_HOSTED_PORT");
  }
  if (!rawDatabasePath || rawDatabasePath.includes("\0")) invalid.push("OPENBOT_SELF_HOSTED_DATABASE_PATH");
  if (rawMode !== "development" && rawMode !== "production") invalid.push("OPENBOT_SELF_HOSTED_MODE");
  if (rawExposeDevelopmentCode !== "true" && rawExposeDevelopmentCode !== "false") {
    invalid.push("OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE");
  }
  if (rawExposeDevelopmentCode === "true" && rawMode !== "development") {
    invalid.push("OPENBOT_SELF_HOSTED_MODE", "OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE");
  }
  if (invalid.length > 0) throw new SelfHostedConfigError(invalid);
  const mode = rawMode === "development" ? "development" : "production";

  return {
    host,
    port,
    databasePath:
      rawDatabasePath === ":memory:"
        ? rawDatabasePath
        : configuredDatabasePath
          ? resolve(workingDirectory, configuredDatabasePath)
          : DEFAULT_DATABASE_PATH,
    mode,
    exposeDevelopmentCode: rawExposeDevelopmentCode === "true",
    ...(environment.OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK?.trim()
      ? { remoteTicketPrivateJwk: environment.OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK.trim() }
      : {}),
    ...(environment.OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS?.trim()
      ? { remoteTicketPublicJwks: environment.OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS.trim() }
      : {}),
    ...(environment.OPENBOT_SELF_HOSTED_TICKET_KEY_ID?.trim()
      ? { remoteTicketKeyId: environment.OPENBOT_SELF_HOSTED_TICKET_KEY_ID.trim() }
      : {}),
  };
}

/** Read a complete, TLS-only SMTP configuration. Partial settings never enable email delivery. */
export function readSelfHostedSmtpConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): SelfHostedSmtpConfiguration {
  const values = {
    EMAIL_SMTP_HOST: environment.EMAIL_SMTP_HOST?.trim() ?? "",
    EMAIL_SMTP_PORT: environment.EMAIL_SMTP_PORT?.trim() ?? "",
    EMAIL_SMTP_USERNAME: environment.EMAIL_SMTP_USERNAME?.trim() ?? "",
    EMAIL_SMTP_PASSWORD: environment.EMAIL_SMTP_PASSWORD ?? "",
    EMAIL_FROM: environment.EMAIL_FROM?.trim() ?? "",
  };
  if (Object.values(values).every((value) => value.trim().length === 0)) return { status: "not_configured" };

  const invalid = new Set<string>();
  for (const name of SELF_HOSTED_SMTP_VARIABLES) {
    if (!values[name].trim()) invalid.add(name);
  }
  if (values.EMAIL_SMTP_HOST && !isValidHostname(values.EMAIL_SMTP_HOST, false)) invalid.add("EMAIL_SMTP_HOST");
  if (values.EMAIL_SMTP_PORT && values.EMAIL_SMTP_PORT !== "465") invalid.add("EMAIL_SMTP_PORT");
  if (values.EMAIL_SMTP_USERNAME && !normalizeEmailAddress(values.EMAIL_SMTP_USERNAME)) {
    invalid.add("EMAIL_SMTP_USERNAME");
  }
  if (values.EMAIL_SMTP_PASSWORD?.includes("\r") || values.EMAIL_SMTP_PASSWORD?.includes("\n")) {
    invalid.add("EMAIL_SMTP_PASSWORD");
  }
  if (values.EMAIL_FROM && !normalizeEmailAddress(values.EMAIL_FROM)) invalid.add("EMAIL_FROM");
  if (invalid.size > 0) {
    return {
      status: "invalid",
      variables: SELF_HOSTED_SMTP_VARIABLES.filter((name) => invalid.has(name)),
    };
  }

  return {
    status: "configured",
    config: {
      host: values.EMAIL_SMTP_HOST,
      port: 465,
      username: values.EMAIL_SMTP_USERNAME,
      password: values.EMAIL_SMTP_PASSWORD,
      from: values.EMAIL_FROM,
    },
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}
