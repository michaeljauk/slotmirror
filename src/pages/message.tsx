import { useI18n } from "../i18n";
import { Layout } from "./layout";

/** A short notice with a link back to the start page. */
export function MessagePage(props: { title: string; message: string }) {
  const { t } = useI18n();
  return (
    <Layout title={props.title}>
      <div class="center">
        <div class="card">
          <h1>{props.title}</h1>
          <p class="lead">{props.message}</p>
          <div class="actions">
            <a class="button" href="/">
              {t.messages.back}
            </a>
          </div>
        </div>
      </div>
    </Layout>
  );
}
