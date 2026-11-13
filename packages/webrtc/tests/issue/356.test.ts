import { setTimeout } from "timers/promises";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
} from "../../src";
import {
  ringCentralOffer,
  withoutAddresslessRtcp,
  withoutSsrcAndMidExtension,
} from "./356.fixture";

/** Arrange: answer the RingCentral offer and capture the announced track. */
async function answerRingCentral() {
  const pc = new RTCPeerConnection();
  const announced: MediaStreamTrack[] = [];
  pc.ontrack = ({ track }) => announced.push(track);
  // #355 が直るまでは a=rtcp:48037 だけを除く (fixture 自体は原文のまま)。
  await pc.setRemoteDescription({
    type: "offer",
    sdp: withoutAddresslessRtcp(ringCentralOffer),
  });
  await pc.setLocalDescription(await pc.createAnswer());
  const [transceiver] = pc.getTransceivers();
  const dtls = transceiver.receiver.dtlsTransport;
  const payloads: string[] = [];
  announced[0].onReceiveRtp.subscribe((rtp) =>
    payloads.push(rtp.payload.toString()),
  );
  const rtp = (ssrc: number, payloadType: number, sequenceNumber: number) =>
    new RtpPacket(
      new RtpHeader({ ssrc, payloadType, sequenceNumber, timestamp: 160 }),
      Buffer.from(`pt${payloadType}-${sequenceNumber}`),
    );
  return { pc, announced, transceiver, dtls, payloads, rtp };
}

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

/**
 * Arrange: pc1 sends `kinds` (one track each) to pc2 with SSRCs and the MID
 * extension removed from its offer, as a peer without them does.
 */
async function connectWithoutSsrc(kinds: ("audio" | "video")[]) {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  const sent = kinds.map((kind) => {
    const track = new MediaStreamTrack({ kind });
    const transceiver = pc1.addTransceiver(track, { direction: "sendonly" });
    return { kind, track, transceiver };
  });
  const announced: MediaStreamTrack[] = [];
  pc2.ontrack = ({ track }) => announced.push(track);

  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription({
    type: "offer",
    sdp: withoutSsrcAndMidExtension(pc1.localDescription!.sdp),
  });
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription!);
  await Promise.all(
    sent.map(
      ({ transceiver }) =>
        new Promise<void>((resolve) =>
          transceiver.sender.onReady.subscribe(() => resolve()),
        ),
    ),
  );

  const received = announced.map((track) => {
    const payloads: string[] = [];
    track.onReceiveRtp.subscribe((rtp) =>
      payloads.push(rtp.payload.toString()),
    );
    return payloads;
  });
  const sendAll = async (count: number) => {
    for (let i = 0; i < count; i++) {
      for (const { kind, track } of sent) {
        track.writeRtp(new RtpPacket(new RtpHeader(), Buffer.from(kind)));
      }
      await setTimeout(20);
    }
  };
  const close = () => Promise.all([pc1.close(), pc2.close()]);
  return { pc2, announced, received, sendAll, close };
}

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
    expect(new Set(received[0])).toEqual(new Set(["audio"]));
    expect(new Set(received[1])).toEqual(new Set(["video"]));
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
