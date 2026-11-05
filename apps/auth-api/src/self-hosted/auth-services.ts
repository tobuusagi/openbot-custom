import { Effect, Schema } from "effect";
import { importJWK, jwtVerify, SignJWT } from "jose";
import { NO_ACCOUNT_ANALYTICS } from "../server/account-analytics";
import { accountSessionLogoutDatabaseFromAuthD1, endAccountSession } from "../server/account-session-logout";
import { type AuthHttpHandlers, createAuthHttpHandlers } from "../server/auth-http";
import { AuthService } from "../server/auth-service";
import { type AuthD1Database, type AuthD1RowDecoder, D1AuthRepository } from "../server/d1-auth-repository";
import { runApiEffect } from "../server/effect-runtime";
import { RemoteControlPlaneError, RemoteTicketSigner } from "../server/remote-control-plane";
import type { EmailCodeDelivery } from "../server/types";
import { SelfHostedSchemaError, validateSelfHostedAuthSchema } from "./schema";

const SELF_HOSTED_AUTH_CONFIG_ERROR_CODES = [
  "schema_not_ready",
  "company_sign_in_not_supported",
  "ticket_signing_not_configured",
  "ticket_signing_invalid",
  "development_code_not_allowed",
] as const;

export class SelfHostedAuthConfigurationError extends Schema.TaggedError<SelfHostedAuthConfigurationError>()(
  "SelfHostedAuthConfigurationError",
  { code: Schema.Literals(SELF_HOSTED_AUTH_CONFIG_ERROR_CODES) },
) {
  constructor(code: (typeof SELF_HOSTED_AUTH_CONFIG_ERROR_CODES)[number]) {
    super({ code });
  }
}

export interface SelfHostedAuthSettings {
  host: string;
  mode: "development" | "production";
  exposeDevelopmentCode: boolean;
  remoteTicketPrivateJwk?: string;
  remoteTicketPublicJwks?: string;
  remoteTicketKeyId?: string;
}

export interface SelfHostedAuthServices {
  readonly authService: AuthService;
  readonly handlers: AuthHttpHandlers;
}

const enabledCompanyRowSchema = Schema.Struct({ active: Schema.Number });
const decodeEnabledCompanyRow: AuthD1RowDecoder<typeof enabledCompanyRowSchema.Type> =
  Schema.decodeUnknownSync(enabledCompanyRowSchema);
const privateTicketJwkSchema = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
});
const publicTicketJwkSchema = Schema.Struct({
  kid: Schema.String,
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});

/** Builds process-owned account services. It validates, but never migrates, the local database. */
export async function createSelfHostedAuthServices(
  database: AuthD1Database,
  settings: SelfHostedAuthSettings,
  delivery: EmailCodeDelivery | null,
): Promise<SelfHostedAuthServices> {
  if (settings.exposeDevelopmentCode && (settings.mode !== "development" || !isLoopbackHost(settings.host))) {
    throw new SelfHostedAuthConfigurationError("development_code_not_allowed");
  }

  try {
    await runApiEffect(validateSelfHostedAuthSchema(database));
  } catch (error) {
    if (error instanceof SelfHostedSchemaError) throw new SelfHostedAuthConfigurationError("schema_not_ready");
    throw new SelfHostedAuthConfigurationError("schema_not_ready");
  }

  try {
    await runApiEffect(assertNoEnabledCompanySignIn(database));
  } catch (error) {
    if (error instanceof SelfHostedAuthConfigurationError) throw error;
    throw new SelfHostedAuthConfigurationError("schema_not_ready");
  }

  const signer = await checkedTicketSigner(settings);
  const authService = new AuthService({
    repository: new D1AuthRepository(database),
    delivery,
    exposeDevelopmentCode: settings.exposeDevelopmentCode,
    analytics: NO_ACCOUNT_ANALYTICS,
  });
  const logoutDatabase = accountSessionLogoutDatabaseFromAuthD1(database);
  const handlers = createAuthHttpHandlers({
    startEmailSignIn: authService.startEmailSignIn,
    verifyEmailCode: authService.verifyEmailCode,
    authenticate: authService.authenticate,
    authenticateDesktopSession: authService.authenticateDesktopSession,
    endAccountSession: (userId, authSessionHash) =>
      endAccountSession({
        database: logoutDatabase,
        userId,
        authSessionHash,
        now: Date.now(),
        sessionAlreadyEnded: () =>
          new RemoteControlPlaneError(401, "auth_session_revoked", "The account session has ended."),
        databaseFailure: () =>
          new RemoteControlPlaneError(500, "internal_error", "The account service could not complete the request."),
        flushAuthEvents: () => Effect.void,
      }),
    publicJwks: () => signer.publicJwks(),
  });
  return { authService, handlers };
}

const assertNoEnabledCompanySignIn = Effect.fn("SelfHostedAuth.assertNoCompanySignIn")(function* (
  database: AuthD1Database,
): Effect.fn.Return<void, SelfHostedAuthConfigurationError> {
  const enabled = yield* Effect.tryPromise({
    try: () =>
      database
        .prepare(
          `SELECT 1 AS active FROM company_sign_in_domains
             JOIN company_sign_in_connections USING (host_id)
             WHERE company_sign_in_connections.enabled = 1 LIMIT 1`,
        )
        .first(decodeEnabledCompanyRow),
    catch: () => new SelfHostedAuthConfigurationError("schema_not_ready"),
  });
  if (enabled) return yield* new SelfHostedAuthConfigurationError("company_sign_in_not_supported");
});

async function checkedTicketSigner(settings: SelfHostedAuthSettings): Promise<RemoteTicketSigner> {
  const privateJwk = settings.remoteTicketPrivateJwk;
  const publicJwks = settings.remoteTicketPublicJwks;
  const keyId = settings.remoteTicketKeyId;
  if (!privateJwk || !publicJwks || !keyId) {
    throw new SelfHostedAuthConfigurationError("ticket_signing_not_configured");
  }

  try {
    const signer = new RemoteTicketSigner({ privateJwk, publicJwks, keyId });
    const active = signer.publicJwks().keys.find((key) => key.kid === keyId);
    if (!active) throw new Error("active_key_missing");
    const privateKeyConfig = Schema.decodeUnknownSync(privateTicketJwkSchema)(JSON.parse(privateJwk));
    const publicKeyConfig = Schema.decodeUnknownSync(publicTicketJwkSchema)(active);
    const signingKey = await importJWK(privateKeyConfig, "ES256");
    const verifyingKey = await importJWK(publicKeyConfig, "ES256");
    const probe = await new SignJWT({ purpose: "self-hosted-key-pair-check" })
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .sign(signingKey);
    await jwtVerify(probe, verifyingKey, { algorithms: ["ES256"] });
    return signer;
  } catch {
    throw new SelfHostedAuthConfigurationError("ticket_signing_invalid");
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}
