import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";

export const SELF_HOSTED_SYSTEMD_CREDENTIALS = [
  "OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK",
  "OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS",
  "OPENBOT_SELF_HOSTED_TICKET_KEY_ID",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USERNAME",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_FROM",
] as const;

export type SelfHostedSystemdCredentialName = (typeof SELF_HOSTED_SYSTEMD_CREDENTIALS)[number];
export type SelfHostedSystemdCredentials = Readonly<Record<SelfHostedSystemdCredentialName, string>>;

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const decodeString = Schema.decodeUnknownSync(Schema.String);

export class SelfHostedSystemdCredentialsError extends Schema.TaggedError<SelfHostedSystemdCredentialsError>()(
  "SelfHostedSystemdCredentialsError",
  { code: Schema.String, credential: Schema.optional(Schema.String) },
) {
  constructor(code: string, credential?: string) {
    super({ code, ...(credential ? { credential } : {}) });
  }
}

/** Reads exactly the known systemd credential files. File contents never enter an error or log. */
export const readSelfHostedSystemdCredentials = Effect.fn("SelfHostedSystemdCredentials.read")(function* (
  directory: string,
): Effect.fn.Return<SelfHostedSystemdCredentials, SelfHostedSystemdCredentialsError> {
  const values: Record<SelfHostedSystemdCredentialName, string> = {
    OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK: "",
    OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS: "",
    OPENBOT_SELF_HOSTED_TICKET_KEY_ID: "",
    EMAIL_SMTP_HOST: "",
    EMAIL_SMTP_PORT: "",
    EMAIL_SMTP_USERNAME: "",
    EMAIL_SMTP_PASSWORD: "",
    EMAIL_FROM: "",
  };
  for (const name of SELF_HOSTED_SYSTEMD_CREDENTIALS) {
    const path = join(directory, name);
    const metadata = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: () => new SelfHostedSystemdCredentialsError("credential_missing", name),
    });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CREDENTIAL_BYTES) {
      return yield* new SelfHostedSystemdCredentialsError("credential_file_invalid", name);
    }
    const content = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)),
        catch: () => new SelfHostedSystemdCredentialsError("credential_file_invalid", name),
      }),
      (file) =>
        Effect.tryPromise({
          try: async () => {
            const info = await file.stat();
            if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) throw new Error("invalid");
            const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
            let offset = 0;
            while (offset < buffer.length) {
              const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
              if (bytesRead === 0) break;
              offset += bytesRead;
            }
            if (offset > MAX_CREDENTIAL_BYTES) throw new Error("invalid");
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
          },
          catch: () => new SelfHostedSystemdCredentialsError("credential_file_invalid", name),
        }),
      (file) =>
        Effect.tryPromise({
          try: () => file.close(),
          catch: () => new SelfHostedSystemdCredentialsError("credential_file_invalid", name),
        }),
    );
    if (!content || content.trim() !== content || /[\0\r\n]/u.test(content)) {
      return yield* new SelfHostedSystemdCredentialsError("credential_value_invalid", name);
    }
    values[name] = decodeString(content);
  }
  return values;
});
