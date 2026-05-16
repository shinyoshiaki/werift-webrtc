import { closeBrowser, closePage, openDevPage, readText, startEchoSession } from "./fixture";

describe("dev turn-loopback app", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("allows the dev SPA to target an arbitrary signaling server URL", async () => {
    const page = await openDevPage();
    const arbitraryServerUrl =
      process.env.TURN_LOOPBACK_E2E_SERVER_BASE_URL ?? "https://127.0.0.1:8443";

    try {
      const signalingInput = page.getByTestId("signaling-base-url");

      // Act: dev サーバー配信の SPA で入力欄を書き換え、任意の HTTPS サーバー URL を指定して接続する。
      expect(await signalingInput.inputValue()).toBe("https://127.0.0.1:65535");
      await startEchoSession(page, arbitraryServerUrl);

      // Assert: 入力した URL に対してセッションが確立し、echo が完了していることを確認する。
      expect(await signalingInput.inputValue()).toBe(arbitraryServerUrl);
      expect(await readText(page, "received-message-value")).toBe(
        await readText(page, "sent-message-value"),
      );
    } finally {
      await closePage(page);
    }
  });
});
