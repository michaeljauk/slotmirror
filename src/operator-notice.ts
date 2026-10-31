/** Longest operator notice we show, in characters. */
export const MAX_OPERATOR_NOTICE = 600;

/**
 * The operator's notice from `OPERATOR_NOTICE`: who runs this deployment and what they can see.
 * Plain text, one paragraph. An empty or unset value gives "", and the pages then show nothing:
 * a self-hoster is the operator and needs no notice.
 */
export function operatorNotice(env: { OPERATOR_NOTICE?: string }): string {
  const text = (env.OPERATOR_NOTICE ?? "").replace(/\s+/g, " ").trim();
  // Count and cut by code points, so that a surrogate pair stays whole.
  const characters = [...text];
  if (characters.length <= MAX_OPERATOR_NOTICE) return text;
  return `${characters.slice(0, MAX_OPERATOR_NOTICE - 1).join("")}…`;
}
