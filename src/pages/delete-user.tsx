import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/**
 * Confirmation before a user is deleted: by themselves ("Delete my data") or by an admin. The POST
 * to `action` does the work.
 */
export function DeleteUserPage(props: {
  user: CurrentUser;
  /** The user who goes; null when users delete themselves. */
  target: { email: string; accounts: number } | null;
  ownAccounts: number;
  action: string;
  cancel: string;
}) {
  const { t } = useI18n();
  const accounts = props.target ? props.target.accounts : props.ownAccounts;
  const title = props.target ? t.deleteUser.titleOther(props.target.email) : t.deleteUser.titleSelf;
  return (
    <Layout title={title} user={props.user} active={props.target ? "admin" : undefined}>
      <div class="center">
        <div class="card">
          <h1>{title}</h1>
          <p class="lead">{t.deleteUser.intro}</p>
          <ul class="prose-list">
            <li>{t.deleteUser.accounts(accounts)}</li>
            <li>{t.deleteUser.rules}</li>
            <li>{t.deleteUser.blocks}</li>
            <li>{t.deleteUser.userRow}</li>
          </ul>
          <p class="lead">{t.deleteUser.activityStays}</p>
          <form class="actions" method="post" action={props.action}>
            <button type="submit" class="button danger">
              {props.target ? t.deleteUser.confirmOther : t.deleteUser.confirmSelf}
            </button>
            <a class="button" href={props.cancel}>
              {t.deleteUser.cancel}
            </a>
          </form>
        </div>
      </div>
    </Layout>
  );
}
