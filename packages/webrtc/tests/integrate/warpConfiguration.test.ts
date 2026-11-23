import {
  openTransportWarpConfigs,
  prepareSplitAnswerWithPreparedTransport,
} from "./warpArrange";

describe("WARP configuration", () => {
  test("BUNDLE 分割の answer 作成後に変えた WARP 設定は、準備中の transport にも反映される", async () => {
    // Arrange: 分割する offer を受けて answer を作った (分割先の transport は準備中)。
    const { offerer, answerer, answer } =
      await prepareSplitAnswerWithPreparedTransport();
    try {
      const before = openTransportWarpConfigs(answerer);

      // Act: answer を適用する前に WARP 設定を変え、その後 answer を適用する。
      answerer.setConfiguration({
        warp: { allowEarlyServerData: false, earlyMediaPolicy: "drop" },
      });
      await answerer.setLocalDescription(answer);

      // Assert: answer 前から開いていた全 transport (既存と分割で準備中) が、
      // 変更後の公開設定と一致する。
      const after = openTransportWarpConfigs(answerer);
      const expected = answerer.getConfiguration().warp;
      expect(expected).toEqual({
        allowEarlyServerData: false,
        earlyMediaPolicy: "drop",
        sendBeforeNomination: false,
      });
      expect(before.length).toBeGreaterThan(1);
      for (const { id } of before) {
        const current = after.find((entry) => entry.id === id);
        expect(current?.warp, `transport ${id}`).toEqual(expected);
      }
      // Assert: 分割後に使われる transport も同じ設定を持つ。
      for (const transport of answerer.dtlsTransports) {
        expect(transport.config.warp).toEqual(answerer.getConfiguration().warp);
      }
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 30_000);

  test("WARP を指定しない設定変更 (iceServers のみ) は再交渉後も例外にならず、WARP 設定を保つ", async () => {
    // Arrange: 接続済みで transport が開いている answerer。
    const { offerer, answerer } =
      await prepareSplitAnswerWithPreparedTransport();
    try {
      const before = answerer.getConfiguration().warp;

      // Act: warp を含まない通常の setConfiguration を呼ぶ。
      const act = () => answerer.setConfiguration({ iceServers: [] });

      // Assert: 例外にならず、WARP 設定と各 transport の設定は変わらない。
      expect(act).not.toThrow();
      expect(answerer.getConfiguration().warp).toEqual(before);
      for (const { id, warp } of openTransportWarpConfigs(answerer)) {
        expect(warp, `transport ${id}`).toEqual(before);
      }
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 30_000);
});
