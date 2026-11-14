import {
  answerServerDataChannelOffer,
  peer,
  requestServerDone,
  waitForDataChannelOpen,
  waitForEventCondition,
} from "../fixture";

// Chrome との DTLS alert 相互運用 (#811): close_notify と fatal alert で
// 両側の状態が ICE consent の期限 (約 30 秒) を待たずに変わること。
describe("datachannel/dtlsAlert", () => {
  it("dtls_alert_close_notify_from_werift", async () => {
    // Arrange
    const label = "dtls_alert_close_notify_from_werift";
    const { pc, channel } = await answerServerDataChannelOffer(label);
    const dc = await channel;
    await waitForDataChannelOpen(dc);
    const dtls = pc.sctp!.transport;
    const dtlsClosed = waitForEventCondition(
      dtls,
      "statechange",
      () => dtls.state === "closed",
    );
    const dcClosed = waitForEventCondition(
      dc,
      "close",
      () => dc.readyState === "closed",
    );

    try {
      // Act: werift が pc.close() して close_notify を送る
      const started = performance.now();
      await peer.request(label, { type: "close" });
      await Promise.all([dtlsClosed, dcClosed]);

      // Assert: Chrome の DTLS / DataChannel が consent 期限よりずっと早く closed になる
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(dtls.state).toBe("closed");
      expect(dc.readyState).toBe("closed");
    } finally {
      pc.close();
      await requestServerDone(label);
    }
  });

  it("dtls_alert_close_notify_from_chrome", async () => {
    // Arrange
    const label = "dtls_alert_close_notify_from_chrome";
    const { pc, channel } = await answerServerDataChannelOffer(label);
    await waitForDataChannelOpen(await channel);

    // Act: Chrome が pc.close() して close_notify を送る
    const closed = peer.request(label, { type: "waitClosed" });
    pc.close();
    const result = await closed;

    // Assert: werift の DTLS / SCTP transport が closed になる
    expect(result).toEqual({ dtlsState: "closed", sctpState: "closed" });
  });

  it("dtls_alert_bad_certificate", async () => {
    // Arrange: werift へ渡す answer の fingerprint をゼロにする
    const label = "dtls_alert_bad_certificate";
    const { pc } = await answerServerDataChannelOffer(label, (sdp) =>
      sdp.replace(
        /a=fingerprint:(\S+) (\S+)/g,
        (_, algorithm: string, value: string) =>
          `a=fingerprint:${algorithm} ${value.replace(/[0-9a-f]/gi, "0")}`,
      ),
    );

    try {
      // Act: werift が Chrome の証明書を拒否して bad_certificate を送るのを待つ
      const weriftFailed = peer.request(label, { type: "waitFailed" });
      await waitForEventCondition(
        pc,
        "connectionstatechange",
        () => pc.connectionState === "failed",
      );

      // Assert: 両側の connectionState と DTLS transport が failed になる
      expect(pc.sctp!.transport.state).toBe("failed");
      expect(await weriftFailed).toEqual({
        connectionState: "failed",
        dtlsState: "failed",
      });
    } finally {
      pc.close();
      await requestServerDone(label);
    }
  });
});
