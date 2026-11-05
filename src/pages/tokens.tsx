import {
  DEFAULT_TOKEN_DAYS,
  MAX_TOKEN_NAME_LENGTH,
  TOKEN_DAYS,
  type ApiToken,
} from "../api-tokens";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/** The user's API tokens. `created` holds a new token, which only this one answer shows. */
export function TokensPage(props: {
  user: CurrentUser;
  tokens: ApiToken[];
  endpoint: string;
  created?: string;
  problem?: string;
}) {
  const { t, formatTimestamp } = useI18n();
  const now = Date.now();
  return (
    <Layout title={t.tokens.title} user={props.user} active="tokens">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.tokens.title}</h1>
            <p class="lead">{t.tokens.lead}</p>
          </div>
        </div>
        {props.problem ? <p class="notice error">{props.problem}</p> : null}
        {props.created ? (
          <div class="card token-created" role="status">
            <h2>{t.tokens.createdTitle}</h2>
            <p>{t.tokens.createdHint}</p>
            <code class="token-value">{props.created}</code>
            <p>{t.tokens.claudeCode}</p>
            <code class="token-value">
              {`claude mcp add --transport http slotmirror ${props.endpoint} --header "Authorization: Bearer ${props.created}"`}
            </code>
          </div>
        ) : null}
        <div class="card">
          <form class="token-form" method="post" action="/tokens">
            <label>
              <span>{t.tokens.name}</span>
              <input type="text" name="name" required maxlength={MAX_TOKEN_NAME_LENGTH} />
            </label>
            <label>
              <span>{t.tokens.lifetime}</span>
              <select name="days">
                {TOKEN_DAYS.map((days) => (
                  <option value={String(days)} selected={days === DEFAULT_TOKEN_DAYS}>
                    {t.tokens.days(days)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" class="button primary">
              {t.tokens.create}
            </button>
          </form>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.tokens.listTitle}</h2>
            <p class="lead">{t.tokens.readOnly(props.endpoint)}</p>
          </div>
        </div>
        {props.tokens.length === 0 ? (
          <p class="muted">{t.tokens.empty}</p>
        ) : (
          <div class="card">
            <table class="table stack">
              <thead>
                <tr>
                  <th>{t.tokens.name}</th>
                  <th>{t.tokens.ends}</th>
                  <th>{t.tokens.expires}</th>
                  <th>{t.tokens.lastUsed}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {props.tokens.map((token) => (
                  <tr>
                    <td data-label={t.tokens.name}>{token.name}</td>
                    <td data-label={t.tokens.ends}>
                      <code>{`…${token.lastFour}`}</code>
                    </td>
                    <td data-label={t.tokens.expires}>
                      {Date.parse(token.expiresAt) <= now
                        ? t.tokens.expired
                        : formatTimestamp(token.expiresAt)}
                    </td>
                    <td class="muted" data-label={t.tokens.lastUsed}>
                      {token.lastUsedAt ? formatTimestamp(token.lastUsedAt) : t.tokens.never}
                    </td>
                    <td>
                      <form method="post" action={`/tokens/${token.id}/revoke`} class="inline-form">
                        <button type="submit" class="link-button quiet">
                          {t.tokens.revoke}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}
