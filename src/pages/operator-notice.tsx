import { useI18n } from "../i18n";

/**
 * The operator's notice. Render it once on a page, before the first link that connects an
 * account. Empty text renders nothing.
 */
export function OperatorNotice(props: { text?: string }) {
  const { t } = useI18n();
  if (!props.text) return null;
  return (
    <aside class="notice info operator-notice" aria-labelledby="operator-notice-title">
      <strong id="operator-notice-title">{t.accounts.operatorNoticeTitle}</strong>
      <p>{props.text}</p>
      <a href="/privacy">{t.accounts.operatorNoticeLink}</a>
    </aside>
  );
}
