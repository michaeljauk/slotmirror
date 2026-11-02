import type { SignedInUser } from "./users";

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SignedInUser | null; language: string };
};
