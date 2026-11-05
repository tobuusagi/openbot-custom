import type { CentralAuthState, VerifyEmailCodeInput } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { CentralAuthOperationError } from "./central-auth-effects";
import { CentralAuthManager } from "./central-auth-manager";

export interface ClientAccountSecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type ClientAccountFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientAccountServiceOptions {
  apiOrigin: string;
  storagePath: string;
  secureStorage: ClientAccountSecureStorage;
  fetch?: ClientAccountFetcher;
}

/** The account-only service surface used by the bundled client window. */
export interface ClientAccountService {
  initialize(): Effect.Effect<CentralAuthState, CentralAuthOperationError>;
  getState(): CentralAuthState;
  retry(): Effect.Effect<CentralAuthState, CentralAuthOperationError>;
  requestEmailCode(email: string): Effect.Effect<CentralAuthState, CentralAuthOperationError>;
  verifyEmailCode(input: VerifyEmailCodeInput): Effect.Effect<CentralAuthState, CentralAuthOperationError>;
  logout(): Effect.Effect<CentralAuthState, CentralAuthOperationError>;
  onChanged(listener: (state: CentralAuthState) => void): () => void;
  dispose(): Effect.Effect<void>;
}

/**
 * A narrow facade over the existing account manager. The caller supplies the API and storage
 * adapters so the test-only entry can use a loopback service; the production entry binds both to
 * the product origin and Electron safeStorage.
 */
export function createClientAccountService(options: ClientAccountServiceOptions): ClientAccountService {
  const manager = new CentralAuthManager({
    apiUrl: options.apiOrigin,
    storagePath: options.storagePath,
    canPersist: () => options.secureStorage.isEncryptionAvailable(),
    encrypt: (value) => options.secureStorage.encryptString(value),
    decrypt: (value) => options.secureStorage.decryptString(value),
    companySignInBrowser: null,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const secureStorageFailure = (): CentralAuthState => ({
    status: "error",
    issue: {
      code: "secure_storage_unavailable",
      message: sourceText("error.app.secretStorageUnavailable"),
    },
  });

  const initialize = Effect.fn("ClientAccount.initialize")(function* () {
    if (!options.secureStorage.isEncryptionAvailable()) return secureStorageFailure();
    return yield* manager.initialize();
  });
  const retry = Effect.fn("ClientAccount.retry")(function* () {
    if (!options.secureStorage.isEncryptionAvailable()) return secureStorageFailure();
    return yield* manager.retry();
  });
  const requestEmailCode = Effect.fn("ClientAccount.requestEmailCode")(function* (email: string) {
    if (!options.secureStorage.isEncryptionAvailable()) return secureStorageFailure();
    return yield* manager.requestEmailCode(email);
  });
  const verifyEmailCode = Effect.fn("ClientAccount.verifyEmailCode")(function* (input: VerifyEmailCodeInput) {
    if (!options.secureStorage.isEncryptionAvailable()) return secureStorageFailure();
    const state = yield* manager.verifyEmailCode(input.challengeId, input.code);
    if (state.status === "signed_in" && !options.secureStorage.isEncryptionAvailable()) {
      yield* manager.logout();
      return secureStorageFailure();
    }
    return state;
  });

  return {
    initialize,
    getState: () => (options.secureStorage.isEncryptionAvailable() ? manager.getState() : secureStorageFailure()),
    retry,
    requestEmailCode,
    verifyEmailCode,
    logout: manager.logout,
    onChanged: (listener) => {
      const onChanged = (state: CentralAuthState) =>
        listener(options.secureStorage.isEncryptionAvailable() ? state : secureStorageFailure());
      manager.on("changed", onChanged);
      return () => manager.off("changed", onChanged);
    },
    dispose: () => manager.dispose().pipe(Effect.asVoid),
  };
}
