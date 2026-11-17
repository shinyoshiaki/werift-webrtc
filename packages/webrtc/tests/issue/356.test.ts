import { answerRingCentral } from "../media/ssrcLess/peers";
import { ringCentralOffer, withoutAddresslessRtcp } from "./356.fixture";

describe("issue #356 RTP without a=ssrc in SDP", () => {
  test("fixture は原文のままで、除くのは a=rtcp:48037 の 1 行だけ", () => {
    // Act
    const sdp = withoutAddresslessRtcp(ringCentralOffer);

    // Assert: 原文は a=rtcp:48037 を含み、ヘルパーはその行だけを消す
    expect(ringCentralOffer).toContain("\r\na=rtcp:48037\r\n");
    expect(sdp).not.toContain("a=rtcp:");
    expect(sdp).toContain("a=rtcp-mux");
    expect(ringCentralOffer.split("\r\n").length - 1).toBe(
      sdp.split("\r\n").length,
    );
  });

  test("RingCentral offer の RTP が ontrack の track に初回から届く", async () => {
    // Arrange
    const { pc, announced, transceiver, dtls, payloads, rtp } =
      await answerRingCentral();
    expect(announced).toHaveLength(1);
    expect(announced[0].ssrc).toBeUndefined();

    // offer にあるが answer で交渉しなかった PT (どれになるかは codec 選択に任せる)
    const offered = [63, 109, 111, 18, 0, 8, 9, 96, 101];
    const negotiatedCodecs = transceiver.codecs;
    const unnegotiated = offered.filter(
      (pt) => !negotiatedCodecs.some((codec) => codec.payloadType === pt),
    );
    expect(unnegotiated.length).toBeGreaterThan(0);
    expect(
      negotiatedCodecs
        .find((codec) => codec.payloadType === 0)
        ?.mimeType.toLowerCase(),
    ).toBe("audio/pcmu");

    // Act: MID / RID 拡張なしで、交渉しなかった PT と PCMU (0) を流す
    unnegotiated.forEach((pt, i) => dtls.onRtp.execute(rtp(0x1234, pt, i)));
    dtls.onRtp.execute(rtp(0x1234, 0, 100));
    dtls.onRtp.execute(rtp(0x1234, 0, 101));

    // Assert: 交渉しなかった PT からは学習せず、PCMU の初回パケットから通知済みの track に届く
    expect(payloads).toEqual(["pt0-100", "pt0-101"]);
    expect(transceiver.receiver.track).toBe(announced[0]);
    expect(announced[0].ssrc).toBe(0x1234);
    expect(announced[0].codec?.mimeType.toLowerCase()).toBe("audio/pcmu");
    await pc.close();
  });
});
