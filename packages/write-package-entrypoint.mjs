import { writeFile } from "node:fs/promises";

const packageName = process.argv[2];
const supportedPackages = new Set([
  "common",
  "dtls",
  "ice",
  "ice-server",
  "rtp",
  "sctp",
]);

if (!packageName || !supportedPackages.has(packageName)) {
  throw new Error(`Unsupported package entrypoint: ${packageName ?? "<missing>"}`);
}

await Promise.all([
  writeFile(
    `lib/index.js`,
    `module.exports = require("./${packageName}/src/index.js");\n`,
  ),
  writeFile(`lib/index.d.ts`, `export * from "./${packageName}/src/index";\n`),
]);
