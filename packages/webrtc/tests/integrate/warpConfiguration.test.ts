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
});
