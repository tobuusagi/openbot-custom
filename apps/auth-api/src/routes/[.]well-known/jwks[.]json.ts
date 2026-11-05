import { createFileRoute } from "@tanstack/solid-router";
import { publicJwksResponse } from "../../server/auth-http";
import { requestRemoteControlPlane } from "../../server/request-auth";

export const Route = createFileRoute("/.well-known/jwks.json")({
  server: { handlers: { GET: () => publicJwksResponse(requestRemoteControlPlane().publicJwks()) } },
});
