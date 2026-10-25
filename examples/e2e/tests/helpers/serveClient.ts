import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { e2eRoot, examplesRoot, repoRoot } from "./paths.js";

export function rewriteClientHtml(html: string, signalingPort: number) {
  return html
    .replace(/wss:\/\/[^\s"'`<>]+/g, `ws://127.0.0.1:${signalingPort}`)
    .replace(/ws:\/\/\d+\.\d+\.\d+\.\d+:\d+/g, `ws://127.0.0.1:${signalingPort}`)
    .replace(/ws:\/\/localhost:\d+/g, `ws://127.0.0.1:${signalingPort}`)
    .replace(/ws:\/\/127\.0\.0\.1:\d+/g, `ws://127.0.0.1:${signalingPort}`);
}

function contentType(filePath: string) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

export async function startStaticServer(options: {
  port: number;
  signalingPort: number;
}) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const relative = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = path.resolve(examplesRoot, `.${relative}`);
    if (!filePath.startsWith(examplesRoot)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body: Buffer | string = fs.readFileSync(filePath);
    if (filePath.endsWith(".html")) {
      body = rewriteClientHtml(body.toString("utf8"), options.signalingPort);
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function startViteServer(options: {
  root: string;
  port: number;
}) {
  const { createServer } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const { nodePolyfills } = await import("vite-plugin-node-polyfills");

  const stub = path.resolve(e2eRoot, "tests/helpers/browserNodeStubs.ts");
  const server = await createServer({
    configFile: false,
    root: options.root,
    plugins: [
      react(),
      nodePolyfills({
        exclude: ["dgram", "net", "tls", "fs", "child_process"],
      }),
    ],
    server: {
      host: "127.0.0.1",
      port: options.port,
      strictPort: true,
      fs: {
        allow: [repoRoot],
      },
    },
    resolve: {
      alias: {
        buffer: "buffer/",
        dgram: stub,
        "node:dgram": stub,
        net: stub,
        "node:net": stub,
      },
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react/jsx-runtime", "sdp-transform", "buffer"],
    },
  });
  await server.listen();

  return {
    url: `http://127.0.0.1:${options.port}`,
    close: () => server.close(),
  };
}

export function clientPageUrl(
  serverUrl: string,
  htmlRelative: string,
  client: "babel" | "vite",
) {
  if (client === "vite") {
    return `${serverUrl}/`;
  }
  return `${serverUrl}/${htmlRelative.split(path.sep).join("/")}`;
}