import { useI18n } from "../i18n";
import { Layout } from "./layout";

/** The text for an administrator, shown in a field that the visitor can copy. */
export interface AdminRequest {
  title: string;
  text: string;
}

export interface OAuthErrorProps {
  title: string;
  lead: string;
  /** More text below the lead, e.g. what to do next. */
  steps?: string;
  /** Safe code (see `oauth-errors.ts`), never provider text. */
  code: string | null;
  reference: string;
  /** Link to the troubleshooting page, with the anchor of the code if it has one. */
  helpHref: string;
  retryHref: string;
  request?: AdminRequest;
}

/**
 * A provider error with a code instead of the provider's text. Left-aligned, because the code and
 * the request are meant to be read and copied. The copy button needs the shared script; without
 * it the field is still selectable.
 */
export function OAuthErrorPage(props: OAuthErrorProps) {
  const { t } = useI18n();
  return (
    <Layout title={props.title}>
      <div class="center wide">
        <div class="card error-card">
          <h1>{props.title}</h1>
          <p class="lead">{props.lead}</p>
          {props.steps ? <p class="lead">{props.steps}</p> : null}
          {props.request ? (
            <div class="request">
              <h2>{props.request.title}</h2>
              <textarea
                id="admin-request"
                class="request-text"
                readonly
                rows={11}
                aria-label={props.request.title}
              >
                {props.request.text}
              </textarea>
              <button
                type="button"
                class="button small"
                data-copy="admin-request"
                data-copied={t.oauthError.copied}
              >
                {t.oauthError.copy}
              </button>
            </div>
          ) : null}
          <dl class="error-facts">
            {props.code ? (
              <>
                <dt>{t.oauthError.codeLabel}</dt>
                <dd>
                  <code>{props.code}</code>
                </dd>
              </>
            ) : null}
            <dt>{t.oauthError.referenceLabel}</dt>
            <dd>
              <code>{props.reference}</code>
            </dd>
          </dl>
          <p class="fineprint">
            <a href={props.helpHref}>{t.oauthError.help}</a>
          </p>
          <div class="actions">
            <a class="button primary" href={props.retryHref}>
              {t.oauthError.tryAgain}
            </a>
            <a class="button" href="/">
              {t.oauthError.back}
            </a>
          </div>
        </div>
      </div>
    </Layout>
  );
}
