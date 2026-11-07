/**
 * The part of `node:async_hooks` that the Workers adapter uses. The Workers types of this project
 * do not include Node types; workerd provides the module through `nodejs_compat`.
 */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
