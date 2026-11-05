import { AppLogo } from "@openbot/brand";
import type { CentralAuthState, CentralAuthUser, VerifyEmailCodeInput } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { AccountLogin } from "@openbot/ui/features/account/AccountLogin";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";

export function ClientAccountView() {
  const { errorMessage, locale, t } = useText();
  const [state, setState] = createSignal<CentralAuthState>({ status: "loading" });
  const [logoutPending, setLogoutPending] = createSignal(false);
  const [logoutError, setLogoutError] = createSignal<string | null>(null);
  const account = window.clientAccount;
  const signedInUser = createMemo(() => {
    const current = state();
    return current.status === "signed_in" ? current.user : null;
  });

  onSettled(() => {
    let eventRevision = 0;
    const unsubscribe = account.onEvent((next) => {
      eventRevision += 1;
      setState(next);
    });
    const revisionAtRead = eventRevision;
    void account
      .getState()
      .then((next) => {
        if (eventRevision === revisionAtRead) setState(next);
      })
      .catch(() => {
        if (eventRevision === revisionAtRead) {
          setState({
            status: "error",
            issue: { code: "auth_unavailable", message: t("account.login.loadFailed") },
          });
        }
      });
    return unsubscribe;
  });

  onCleanup(() => setLogoutPending(false));

  const retry = async () => {
    setState(await account.retry());
  };
  const requestEmailCode = async (email: string) => {
    setState(await account.requestEmailCode(email));
  };
  const verifyEmailCode = async (challengeId: string, code: string) => {
    const input: VerifyEmailCodeInput = { challengeId, code };
    setState(await account.verifyEmailCode(input));
  };
  const logout = async () => {
    setLogoutPending(true);
    setLogoutError(null);
    try {
      setState(await account.logout());
    } catch (error) {
      setLogoutError(errorMessage(error, t("account.menu.signOutFailed")));
    } finally {
      setLogoutPending(false);
    }
  };

  return (
    <Show
      when={signedInUser()}
      fallback={
        <AccountLogin
          variant="production"
          state={state()}
          onRetry={retry}
          onRequestEmailCode={requestEmailCode}
          onVerifyEmailCode={verifyEmailCode}
          onReset={async () => {
            setState(await account.logout());
          }}
          language={locale()}
        />
      }
    >
      {(user) => <SignedInAccount user={user()} pending={logoutPending()} error={logoutError()} onLogout={logout} />}
    </Show>
  );
}

function SignedInAccount(props: {
  user: CentralAuthUser;
  pending: boolean;
  error: string | null;
  onLogout: () => Promise<void>;
}) {
  const { t } = useText();

  return (
    <main class="account-login-screen client-account-screen">
      <div class="account-login-shell client-account-shell">
        <AppLogo variant="production" animation="blink" interactive class="account-login-logo" />
        <section class="client-account-panel" aria-labelledby="client-account-title">
          <h1 id="client-account-title">{t("account.login.signedInTitle")}</h1>
          <p class="client-account-name">{props.user.name ?? props.user.email}</p>
          {props.user.name && <p class="client-account-email">{props.user.email}</p>}
          <Show when={props.error}>
            {(error) => (
              <p class="account-login-error" role="alert">
                {error()}
              </p>
            )}
          </Show>
          <Button
            class="account-login-primary client-account-sign-out"
            disabled={props.pending}
            loading={props.pending}
            loadingLabel={t("account.menu.signingOut")}
            onClick={() => void props.onLogout()}
          >
            {t("account.menu.signOut")}
          </Button>
        </section>
      </div>
    </main>
  );
}
