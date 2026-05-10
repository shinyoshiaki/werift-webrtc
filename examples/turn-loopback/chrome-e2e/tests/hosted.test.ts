import type { Page } from "playwright";

import {
  closeBrowser,
  closePage,
  getServerBaseUrl,
  openHostedPage,
  readText,
  startEchoSession,
} from "./fixture";

describe("hosted turn-loopback app", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("serves the built SPA from the same HTTPS origin and completes echo", async () => {
    const page = await openHostedPage();

    try {
      const signalingInput = page.getByTestId("signaling-base-url");

      // Act: サーバー配信の SPA を開き、同一 origin 固定の設定のまま echo セッションを開始する。
      expect(await signalingInput.inputValue()).toBe(getServerBaseUrl());
      expect(await signalingInput.getAttribute("readonly")).not.toBeNull();
      await startEchoSession(page);

      // Assert: 返却された turns URL が実アクセス先と一致し、画面上でも echo 成功が確認できることを確かめる。
      const sentMessage = await readText(page, "sent-message-value");
      expect(await readText(page, "received-message-value")).toBe(sentMessage);
      expect(await readText(page, "turn-url-value")).toBe(
        getServerBaseUrl().replace("https://", "turns:") + "?transport=tcp",
      );
      await expect.poll(async () => readText(page, "connection-state-value")).toBe(
        "connected",
      );
    } finally {
      await closePage(page);
    }
  });

  test("keeps concurrent hosted sessions isolated across multiple pages", async () => {
    const firstPage = await openHostedPage();
    const secondPage = await openHostedPage();

    try {
      // Act: 2 ページを並行で起動し、それぞれ独立したセッションを同時に張る。
      await Promise.all([startEchoSession(firstPage), startEchoSession(secondPage)]);

      // Assert: 各ページが自分の username と echo 結果を保持し、セッションが衝突していないことを確認する。
      await assertIndependentSession(firstPage, secondPage);
    } finally {
      await Promise.all([closePage(firstPage), closePage(secondPage)]);
    }
  });
});

async function assertIndependentSession(firstPage: Page, secondPage: Page) {
  const [firstUsername, secondUsername] = await Promise.all([
    readText(firstPage, "username-value"),
    readText(secondPage, "username-value"),
  ]);
  expect(firstUsername).not.toBe("");
  expect(secondUsername).not.toBe("");
  expect(firstUsername).not.toBe(secondUsername);

  const [firstSent, firstReceived, secondSent, secondReceived] = await Promise.all([
    readText(firstPage, "sent-message-value"),
    readText(firstPage, "received-message-value"),
    readText(secondPage, "sent-message-value"),
    readText(secondPage, "received-message-value"),
  ]);

  expect(firstReceived).toBe(firstSent);
  expect(secondReceived).toBe(secondSent);
  expect(firstSent).not.toBe(secondSent);
}
