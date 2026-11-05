import { createFileRoute } from "@tanstack/solid-router";
import { createAuthHttpHandlers } from "../../../../server/auth-http";
import { authErrorResponse, requestAuthService, requestRemoteControlPlane } from "../../../../server/request-auth";
import { requestSourceIp } from "../../../../server/source-ip";

export const Route = createFileRoute("/v1/auth/email/verify")({
  server: {
    handlers: {
      POST: ({ request }) => {
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
        return http.verifyEmailCode(request, requestSourceIp(request));
      },
    },
  },
});
