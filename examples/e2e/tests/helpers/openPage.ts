import { existsSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import {
  chromiumContextOptions,
  chromiumLaunchArgs,
  chromiumLaunchOptions,
} from "../../playwright.config.js";
import { fixtureMp4, fixtureWebm, vendorDir } from "./paths.js";

const vendorRoutes: Array<{ pattern: RegExp; file: string }> = [
  {
    pattern: /unpkg\.com\/react@16\/umd\/react\.development\.js/,
    file: "react.16.development.js",
  },
  {
    pattern: /unpkg\.com\/react-dom@16\/umd\/react-dom\.development\.js/,
    file: "react-dom.16.development.js",
  },
  {
    pattern: /unpkg\.com\/react@18\/umd\/react\.development\.js/,
    file: "react.18.development.js",
  },
  {
    pattern: /unpkg\.com\/react-dom@18\/umd\/react-dom\.development\.js/,
    file: "react-dom.18.development.js",
  },
  {
    pattern: /cdnjs\.cloudflare\.com\/ajax\/libs\/babel-core\/5\.8\.34\/browser\.min\.js/,
    file: "babel-core.5.8.34.browser.min.js",
  },
  {
    pattern: /unpkg\.com\/@babel\/standalone\/babel\.min\.js/,
    file: "babel.standalone.min.js",
  },
  {
    pattern: /cdn\.jsdelivr\.net\/npm\/babel-regenerator-runtime@6\.5\.0\/runtime\.min\.js/,
    file: "babel-regenerator-runtime.6.5.0.min.js",
  },
  {
    pattern: /cdn\.jsdelivr\.net\/npm\/axios\/dist\/axios\.min\.js/,
    file: "axios.min.js",
  },
];

let sharedBrowser: Browser | undefined;

const noSandboxArgs = ["--no-sandbox", "--disable-setuid-sandbox"];

function isSandboxLaunchError(error: unknown) {
  return /sandbox/i.test(String(error));
}

export async function getBrowser() {
  if (!sharedBrowser) {
    try {
      sharedBrowser = await chromium.launch({
        ...chromiumLaunchOptions,
        args: [...chromiumLaunchArgs],
      });
    } catch (error) {
      if (!isSandboxLaunchError(error)) {
        throw error;
      }
      sharedBrowser = await chromium.launch({
        ...chromiumLaunchOptions,
        args: [...chromiumLaunchArgs, ...noSandboxArgs],
      });
    }
  }
  return sharedBrowser;
}

export async function closeSharedBrowser() {
  await sharedBrowser?.close();
  sharedBrowser = undefined;
}

export async function openExamplePage(url: string, signalingPort: number) {
  const browser = await getBrowser();
  const context = await browser.newContext(chromiumContextOptions);
  const page = await context.newPage();

  await page.route(
    /unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/,
    async (route) => {
      const requestUrl = route.request().url();
      const mapped = vendorRoutes.find((item) => item.pattern.test(requestUrl));
      if (!mapped) {
        await route.abort();
        return;
      }
      const filePath = path.join(vendorDir, mapped.file);
      if (!existsSync(filePath)) {
        throw new Error(
          `committed vendor file missing: ${mapped.file} (CI must not fetch CDN)`,
        );
      }
      await route.fulfill({
        path: filePath,
        contentType: "application/javascript; charset=utf-8",
      });
    },
  );

  await page.addInitScript({
    content: `(() => {
      const OrigPC = window.RTCPeerConnection;
      function Wrapped(...args) {
        const pc = new OrigPC(...args);
        window.rtc = pc;
        const bag = (window.__weriftE2e = window.__weriftE2e || {
          peers: [],
          dcMessages: [],
          dcStates: [],
        });
        bag.peers.push(pc);
        const trackDc = (dc) => {
          bag.dcStates.push(dc.readyState);
          dc.addEventListener("closing", () => bag.dcStates.push("closing"));
          dc.addEventListener("close", () => bag.dcStates.push("closed"));
          dc.addEventListener("open", () => bag.dcStates.push("open"));
          dc.addEventListener("message", (ev) => {
            const text =
              typeof ev.data === "string"
                ? ev.data
                : new TextDecoder().decode(ev.data);
            bag.dcMessages.push(text);
          });
        };
        pc.addEventListener("datachannel", (ev) => trackDc(ev.channel));
        const origCreate = pc.createDataChannel.bind(pc);
        pc.createDataChannel = (...createArgs) => {
          const dc = origCreate(...createArgs);
          trackDc(dc);
          return dc;
        };
        return pc;
      }
      Wrapped.prototype = OrigPC.prototype;
      Object.setPrototypeOf(Wrapped, OrigPC);
      window.RTCPeerConnection = Wrapped;

      const OrigWS = window.WebSocket;
      window.WebSocket = new Proxy(OrigWS, {
        construct(target, args) {
          let url = args[0];
          if (typeof url === "string") {
            try {
              const parsed = new URL(url);
              if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
                parsed.protocol = "ws:";
                parsed.host = "127.0.0.1:${signalingPort}";
                url = parsed.toString();
              }
            } catch {}
          }
          const ws = args.length > 1 ? new target(url, args[1]) : new target(url);
          let userHandler = null;
          Object.defineProperty(ws, "onmessage", {
            configurable: true,
            get() {
              return userHandler;
            },
            set(fn) {
              userHandler = fn;
            },
          });
          ws.addEventListener("message", (ev) => {
            const deliver = (data) => {
              if (typeof userHandler === "function") {
                userHandler({ data });
              }
            };
            if (ev.data instanceof Blob) {
              ev.data.text().then((text) => {
                if (text) deliver(text);
              });
              return;
            }
            if (ev.data instanceof ArrayBuffer) {
              const text = new TextDecoder().decode(ev.data);
              if (text) deliver(text);
              return;
            }
            if (ev.data !== "" && ev.data != null) {
              deliver(ev.data);
            }
          });
          return ws;
        },
      });
    })();`,
  });

  page.on("console", (msg) => {
    if (process.env.EXAMPLES_E2E_SILENT !== "1") {
      const text = msg.text();
      if (text) {
        process.stdout.write(`[browser] ${text}\n`);
      }
    }
  });
  page.on("pageerror", (error) => {
    process.stdout.write(`[pageerror] ${error.message}\n`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { page, context };
}

export async function closePage(page: Page, context: BrowserContext) {
  await page.close().catch(() => undefined);
  await context.close().catch(() => undefined);
}

export async function attachFixtureFile(
  page: Page,
  kind: "webm" | "mp4",
) {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  await input.setInputFiles(kind === "mp4" ? fixtureMp4 : fixtureWebm);
}

export async function clickNamedButton(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: false }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
}

export async function supportsAv1(page: Page) {
  return page.evaluate(async () => {
    const caps = RTCRtpSender.getCapabilities?.("video");
    return Boolean(
      caps?.codecs.some((codec) => /^video\/av1x?$/i.test(codec.mimeType)),
    );
  });
}
