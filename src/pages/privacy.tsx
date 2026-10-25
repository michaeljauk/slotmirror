import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/** Public privacy statement of a deployment. Reachable without sign-in and before setup. */
export function PrivacyPage(props: {
  operator: string;
  contact: string;
  user?: CurrentUser | null;
}) {
  const { t } = useI18n();
  const p = t.privacy;
  return (
    <Layout title={p.title} user={props.user}>
      <article class="prose">
        <h1>{p.title}</h1>
        <p>{props.contact ? p.operator(props.operator, props.contact) : p.operatorUnknown}</p>
        <p>{p.intro}</p>
        <h2>{p.storedTitle}</h2>
        <ul>
          {p.stored.map((item) => (
            <li>{item}</li>
          ))}
        </ul>
        <h2>{p.notStoredTitle}</h2>
        <p>{p.notStored}</p>
        <h2>{p.whereTitle}</h2>
        <p>{p.where}</p>
        <h2>{p.deleteTitle}</h2>
        <p>{p.delete}</p>
        <h2>{p.googleTitle}</h2>
        <p>{p.google}</p>
        <p class="muted">{p.noTracking}</p>
      </article>
    </Layout>
  );
}
