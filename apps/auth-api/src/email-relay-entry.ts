// The `openbot-email-relay` Worker (`wrangler.email-relay.jsonc`). The account Worker sends each email
// through it over the `EMAIL_RELAY` service binding. It has no route, so only that binding reaches it.
// Cloudflare places it near the mail host: from some locations, such as FSD, a socket to the mail host
// fails at once, and every sign-in code served there failed (#4578).

import { connect } from "cloudflare:sockets";
import { createEmailRelayHandler } from "./server/email-relay-handler";
import type { SmtpConnector } from "./server/smtp-email-delivery";

const workerSmtpConnector: SmtpConnector = (address, options) => connect(address, options);

export default createEmailRelayHandler(workerSmtpConnector) satisfies ExportedHandler;
