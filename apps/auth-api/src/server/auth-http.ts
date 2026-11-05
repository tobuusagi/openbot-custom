import { isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { type AuthService, AuthServiceError } from "./auth-service";
import { sha256 } from "./crypto";
import { runApiResponse } from "./effect-runtime";
import { JsonBodyError, readJsonObject } from "./json-body";
import type { RemoteControlPlane, RemoteTicketSigner } from "./remote-control-plane";

export type AuthHttpServices = Pick<
  AuthService,
  "startEmailSignIn" | "verifyEmailCode" | "authenticate" | "authenticateDesktopSession"
> & {
  endAccountSession: RemoteControlPlane["endAccountSession"];
  publicJwks: RemoteTicketSigner["publicJwks"];
};

export interface AuthHttpHandlers {
  readonly startEmailSignIn: (request: Request, sourceIp: string) => Promise<Response>;
  readonly verifyEmailCode: (request: Request, sourceIp: string) => Promise<Response>;
  readonly me: (request: Request) => Promise<Response>;
  readonly logout: (request: Request) => Promise<Response>;
  readonly jwks: () => Response;
}

/** Creates the shared HTTP boundary used by the Worker routes and local Node runtime. */
export function createAuthHttpHandlers(
  services: AuthHttpServices,
  mapError: (error: unknown) => Response = authHttpErrorResponse,
): AuthHttpHandlers {
  return {
    startEmailSignIn: (request, sourceIp) =>
      runApiResponse(
        Effect.gen(function* () {
          const body = yield* readJsonObject(request);
          if (!isString(body.email)) return apiError(400, "invalid_email", "Enter a valid email address.");
          const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
          return json(yield* services.startEmailSignIn(body.email, sourceIp, idempotencyKey));
        }),
        mapError,
      ),
    verifyEmailCode: (request, sourceIp) =>
      runApiResponse(
        Effect.gen(function* () {
          const body = yield* readJsonObject(request);
          if (!isString(body.challengeId) || !isString(body.code)) {
            return apiError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
          }
          return json(
            yield* services.verifyEmailCode({
              challengeId: body.challengeId,
              code: body.code,
              sourceIp,
              surface: "desktop",
            }),
          );
        }),
        mapError,
      ),
    me: (request) =>
      runApiResponse(
        Effect.gen(function* () {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const user = yield* services.authenticate(token);
          return user ? json(user) : apiError(401, "unauthorized", "The session is invalid.");
        }),
        mapError,
      ),
    logout: (request) =>
      runApiResponse(
        Effect.gen(function* () {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const user = yield* services.authenticateDesktopSession(token);
          if (!user) return apiError(401, "unauthorized", "The session is invalid.");
          yield* services.endAccountSession(user.id, yield* sha256(token));
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        }),
        mapError,
      ),
    jwks: () => publicJwksResponse(services.publicJwks()),
  };
}

/** Dispatches only the five desktop account endpoints. The caller supplies the socket peer address. */
export function handleAuthHttpRequest(
  request: Request,
  sourceIp: string,
  handlers: AuthHttpHandlers,
): Promise<Response> | Response | null {
  const pathname = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (pathname === "/v1/auth/email/start") {
    return method === "POST" ? handlers.startEmailSignIn(request, sourceIp) : methodNotAllowedResponse("POST");
  }
  if (pathname === "/v1/auth/email/verify") {
    return method === "POST" ? handlers.verifyEmailCode(request, sourceIp) : methodNotAllowedResponse("POST");
  }
  if (pathname === "/v1/me") return method === "GET" ? handlers.me(request) : methodNotAllowedResponse("GET");
  if (pathname === "/v1/auth/logout")
    return method === "POST" ? handlers.logout(request) : methodNotAllowedResponse("POST");
  if (pathname === "/.well-known/jwks.json")
    return method === "GET" ? handlers.jwks() : methodNotAllowedResponse("GET");
  return null;
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token && token.length <= 512 ? token : null;
}

export function json<A>(value: A, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function publicJwksResponse(jwks: ReturnType<RemoteTicketSigner["publicJwks"]>): Response {
  return Response.json(jwks, {
    headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}

export function authHttpErrorResponse(error: unknown): Response {
  if (error instanceof JsonBodyError) return apiError(error.status, error.code, error.message);
  if (error instanceof AuthServiceError) {
    const response = apiError(error.status, error.code, error.message);
    if (error.retryAfterSeconds !== undefined) response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  const reference = `auth/${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return json(
    { error: { code: "internal_error", message: "The account service could not complete the request.", reference } },
    500,
  );
}

export function methodNotAllowedResponse(allowed: string): Response {
  const response = apiError(405, "method_not_allowed", "The request method is not allowed.");
  response.headers.set("Allow", allowed);
  return response;
}
