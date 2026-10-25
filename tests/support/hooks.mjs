import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Module resolution for the Node unit tests, which import the app's
// TypeScript sources the way Vite does.
//
// - A relative import without an extension from a `.ts` file resolves to the
//   `.ts` file, as the bundler resolves it.
// - `@laceio/sdk/experimental`, the entry with the custody API, resolves to
//   sdk-node.mjs, which loads the package's CommonJS build: the build the
//   fake ledger and the fake sponsor `require`, so a test shares one SDK
//   instance with them.

const SDK = "@laceio/sdk/experimental";
const sdkShim = new URL("./sdk-node.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === SDK && context.parentURL !== sdkShim) return { url: sdkShim, shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return next(specifier, context);
}
