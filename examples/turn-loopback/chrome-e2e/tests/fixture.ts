import { chromium, type Browser, type Page } from "playwright";

import {
  chromiumContextOptions,
  chromiumLaunchOptions,
} from "../playwright.config";

const serverBaseUrl =
  process.env.TURN_LOOPBACK_E2E_SERVER_BASE_URL ?? "https://127.0.0.1:8443";
const devBaseUrl =
  process.env.TURN_LOOPBACK_E2E_DEV_BASE_URL ?? "http://127.0.0.1:5173";

let sharedBrowser: Browser | undefined;

export async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch(chromiumLaunchOptions);
  }
  return sharedBrowser;
}

export async function closeBrowser() {
  await sharedBrowser?.close();
  sharedBrowser = undefined;
}

export async function openHostedPage() {
  return openPage(serverBaseUrl);
}

export async function openDevPage() {
  return openPage(devBaseUrl);
}

async function openPage(url: string) {
  const browser = await getBrowser();
  const context = await browser.newContext(chromiumContextOptions);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

export async function closePage(page: Page) {
  await page.context().close();
}

export async function startEchoSession(page: Page, signalingBaseUrl?: string) {
  const signalingInput = page.getByTestId("signaling-base-url");
  if (signalingBaseUrl) {
    await signalingInput.fill(signalingBaseUrl);
  }

  const button = page.getByTestId("start-session-button");
  await button.click();
  await expectStatus(page, "received");
}

export async function expectStatus(page: Page, expected: string) {
  await expect.poll(async () => readText(page, "status-value")).toBe(expected);
}

export async function readText(page: Page, testId: string) {
  return (await page.getByTestId(testId).textContent())?.trim() ?? "";
}

export function getServerBaseUrl() {
  return serverBaseUrl;
}
