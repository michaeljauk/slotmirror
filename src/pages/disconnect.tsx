import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/** Confirmation before an account is disconnected. The POST to the same path does the work. */
export function DisconnectPage(props: {
  user: CurrentUser;
  accountId: string;
  email: string;
  /** Rules that use the account as source or target. */
  rules: number;
}) {
  const { t } = useI18n();
  return (
    <Layout title={t.accounts.disconnectTitle} user={props.user} active="accounts">
      <div class="center">
        <div class="card">
          <h1>{t.accounts.disconnectTitle}</h1>
          <p class="lead">{t.accounts.disconnectText(props.email)}</p>
          <p class="lead">{t.accounts.disconnectRules(props.rules)}</p>
          <form class="actions" method="post" action={`/accounts/${props.accountId}/disconnect`}>
            <button type="submit" class="button danger">
              {t.accounts.disconnectConfirm}
            </button>
            <a class="button" href="/">
              {t.accounts.cancel}
            </a>
          </form>
        </div>
      </div>
    </Layout>
  );
}
