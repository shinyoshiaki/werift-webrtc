/**
 * `npm run pbt:deep` of a package: runs the suites its `tests/pbt/suites.ts`
 * exports (a `DeepSearchConfig` as default export) with `runDeepSearch`.
 *
 *   node --import <root>/tools/node-ts/register.mjs <root>/packages/pbt/src/cli.ts tests/pbt/suites.ts [options]
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type DeepSearchConfig, runDeepSearch } from "./deep";

async function main() {
  const [suitesFile, ...argv] = process.argv.slice(2);
  if (!suitesFile) {
    console.error(
      "usage: cli.ts <tests/pbt/suites.ts> [--suite a,b] [--seeds n] [--steps n] [--seed n] [--jobs n] [--list] [--dry-run]",
    );
    process.exit(2);
  }
  const module = await import(pathToFileURL(resolve(suitesFile)).href);
  const config: DeepSearchConfig = module.default;
  process.exit(await runDeepSearch(config, argv));
}

main();
