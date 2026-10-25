import type { CurrentUser } from "./users";

export type AppEnv = {
  Bindings: Env;
  Variables: { user: CurrentUser | null; language: string };
};
