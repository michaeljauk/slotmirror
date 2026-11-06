import type { SignedInUser } from "./users";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SignedInUser | null;
    language: string;
    /** One more origin that a form on this page may submit to, for a redirect after the form. */
    formAction?: string;
  };
};
