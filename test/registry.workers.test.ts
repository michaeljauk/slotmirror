import { env } from "cloudflare:workers";
import { registryContract } from "./registry-contract";

// The same contract runs on the Node runtime in src/runtime/node/registry.node.test.ts.
registryContract(() => env.DB);
