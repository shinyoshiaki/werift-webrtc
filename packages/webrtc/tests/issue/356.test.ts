import { RtcpSenderInfo, RtcpSrPacket } from "../../src";
import {
  answerRingCentral,
  connectWithoutSsrc,
} from "../media/ssrcLessTestUtils";
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

    // Act: MID / RID 拡張なしで、受信 codec 表にない PT (111, 63) と PCMU (0) を流す
    dtls.onRtp.execute(rtp(0x1234, 111, 1));
    dtls.onRtp.execute(rtp(0x1234, 63, 2));
    dtls.onRtp.execute(rtp(0x1234, 0, 3));
    dtls.onRtp.execute(rtp(0x1234, 0, 4));

    // Assert: 未知 PT からは学習せず、PCMU の初回パケットから通知済みの track に届く
    expect(payloads).toEqual(["pt0-3", "pt0-4"]);
    expect(transceiver.receiver.track).toBe(announced[0]);
    expect(announced[0].ssrc).toBe(0x1234);
    expect(announced[0].codec?.mimeType.toLowerCase()).toBe("audio/pcmu");
    await pc.close();
  });

  test("学習後の remote SR が届き、inbound-rtp 統計にその SSRC が出る", async () => {
    // Arrange
    const { pc, announced, transceiver, dtls, rtp } = await answerRingCentral();
    dtls.onRtp.execute(rtp(0x5678, 109, 1));
    const reports: RtcpSrPacket[] = [];
    announced[0].onReceiveRtcp.subscribe((sr) =>
      reports.push(sr as RtcpSrPacket),
    );

    // Act
    dtls.onRtcp.execute(
      new RtcpSrPacket({
        ssrc: 0x5678,
        senderInfo: new RtcpSenderInfo({
          ntpTimestamp: 2208988800n << 32n,
          rtpTimestamp: 0,
          packetCount: 1,
          octetCount: 10,
        }),
        reports: [],
      }),
    );
    const stats = [...(await transceiver.receiver.getStats()).values()];

    // Assert
    expect(reports.map((sr) => sr.ssrc)).toEqual([0x5678]);
    expect(
      stats.find(
        (s) =>
          s.type === "inbound-rtp" && (s as { ssrc?: number }).ssrc === 0x5678,
      ),
    ).toBeDefined();
    await pc.close();
  });
});

describe("issue #356 werift to werift without a=ssrc and MID extension", () => {
  test("BUNDLE の audio + video は PT が分かれていれば各 track に届く", async () => {
    // Arrange
    const { announced, received, sendAll, close } = await connectWithoutSsrc([
      "audio",
      "video",
    ]);
    expect(announced.map((t) => t.kind)).toEqual(["audio", "video"]);

    // Act
    await sendAll(10);

    // Assert: 各 ontrack の track に自分の kind の RTP だけが届く
    expect(received[0].length).toBeGreaterThan(0);
    expect(received[1].length).toBeGreaterThan(0);
    expect(new Set(received[0])).toEqual(new Set(["audio0"]));
    expect(new Set(received[1])).toEqual(new Set(["video1"]));
    await close();
  });

  test("PT が重なる 2 本の audio は推測せず配送しない", async () => {
    // Arrange
    const { announced, received, sendAll, close } = await connectWithoutSsrc([
      "audio",
      "audio",
    ]);
    expect(announced).toHaveLength(2);

    // Act
    await sendAll(10);

    // Assert: どちらの track にも届かない (誤配送しない)
    expect(received).toEqual([[], []]);
    await close();
  });
});
