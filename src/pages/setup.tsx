import type { SetupStatus } from "../config";
import { useI18n } from "../i18n";
import { Layout } from "./layout";

function Item(props: { ok: boolean; name: string; hint: string }) {
  const { t } = useI18n();
  return (
    <li>
      <span class={props.ok ? "check ok" : "check missing"} aria-hidden="true">
        {props.ok ? "✓" : "!"}
      </span>
      <div class="item-main">
        <div class="item-title">
          <code>{props.name}</code>
        </div>
        <div class="item-meta">{props.ok ? t.setup.set : props.hint}</div>
      </div>
    </li>
  );
}

/** Shown until the deployment has everything it needs. Lists names only, never values. */
export function SetupPage(props: { status: SetupStatus }) {
  const { status } = props;
  const { t } = useI18n();
  return (
    <Layout title={t.setup.title}>
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.setup.title}</h1>
            <p class="lead">{t.setup.lead}</p>
          </div>
        </div>
        <div class="card">
          <ul class="list">
            <Item
              ok={status.accessConfigured}
              name="ALLOWED_EMAILS, ALLOWED_DOMAINS or ADMIN_EMAILS"
              hint={t.setup.accessHint}
            />
            <Item ok={status.sessionSecret} name="SESSION_SECRET" hint={t.setup.sessionHint} />
            <Item
              ok={status.tokenEncryptionKey}
              name="TOKEN_ENCRYPTION_KEY"
              hint={t.setup.keyHint}
            />
            <Item
              ok={status.providers.microsoft || status.providers.google}
              name="MICROSOFT_CLIENT_ID + _SECRET or GOOGLE_CLIENT_ID + _SECRET"
              hint={t.setup.providerHint}
            />
          </ul>
        </div>
      </section>
    </Layout>
  );
}
