/**
 * The `cloudflare:workers` module for the Node typecheck (`tsconfig.node.json`): only the base
 * class of `AccountSync`, typed as the runtime subset. The Node runtime provides it as a shim.
 *
 * A module declaration must live in a declaration file. The typecheck does not report errors
 * here, but a broken type in this class fails the check of `src/account-sync.ts`.
 */
declare module "cloudflare:workers" {
  export abstract class DurableObject<E = unknown> {
    protected ctx: import("../types").ActorState;
    protected env: E;
    constructor(ctx: import("../types").ActorState, env: E);
    alarm?(): Promise<void>;
  }
}
