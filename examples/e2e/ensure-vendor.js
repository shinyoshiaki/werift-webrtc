const { createWriteStream, existsSync, mkdirSync } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { join } = require("node:path");

const vendorDir = join(__dirname, "vendor");

const files = [
  {
    url: "https://unpkg.com/react@16/umd/react.development.js",
    name: "react.16.development.js",
  },
  {
    url: "https://unpkg.com/react-dom@16/umd/react-dom.development.js",
    name: "react-dom.16.development.js",
  },
  {
    url: "https://unpkg.com/react@18/umd/react.development.js",
    name: "react.18.development.js",
  },
  {
    url: "https://unpkg.com/react-dom@18/umd/react-dom.development.js",
    name: "react-dom.18.development.js",
  },
  {
    url: "https://cdnjs.cloudflare.com/ajax/libs/babel-core/5.8.34/browser.min.js",
    name: "babel-core.5.8.34.browser.min.js",
  },
  {
    url: "https://unpkg.com/@babel/standalone/babel.min.js",
    name: "babel.standalone.min.js",
  },
  {
    url: "https://cdn.jsdelivr.net/npm/babel-regenerator-runtime@6.5.0/runtime.min.js",
    name: "babel-regenerator-runtime.6.5.0.min.js",
  },
  {
    url: "https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js",
    name: "axios.min.js",
  },
];

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(dest));
}

async function main() {
  mkdirSync(vendorDir, { recursive: true });
  for (const file of files) {
    const dest = join(vendorDir, file.name);
    if (existsSync(dest)) {
      continue;
    }
    if (process.env.CI) {
      throw new Error(
        `vendor file missing in CI; commit examples/e2e/vendor/${file.name} instead of downloading from CDN`,
      );
    }
    console.log(`download vendor ${file.name}`);
    await download(file.url, dest);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
