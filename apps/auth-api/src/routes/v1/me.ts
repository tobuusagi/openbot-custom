import { createFileRoute } from "@tanstack/solid-router";
import { createAuthHttpHandlers } from "../../server/auth-http";
import { authErrorResponse, requestAuthService, requestRemoteControlPlane } from "../../server/request-auth";

export const Route = createFileRoute("/v1/me")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const http = createAuthHttpHandlers(
          {
            startEmailSignIn: (...args) => requestAuthService().startEmailSignIn(...args),
            verifyEmailCode: (...args) => requestAuthService().verifyEmailCode(...args),
            authenticate: (...args) => requestAuthService().authenticate(...args),
            authenticateDesktopSession: (...args) => requestAuthService().authenticateDesktopSession(...args),
            endAccountSession: (userId, authSessionHash) =>
              requestRemoteControlPlane().endAccountSession(userId, authSessionHash),
            publicJwks: () => requestRemoteControlPlane().publicJwks(),
          },
          authErrorResponse,
        );
        return http.me(request);
      },
    },
  },
});
