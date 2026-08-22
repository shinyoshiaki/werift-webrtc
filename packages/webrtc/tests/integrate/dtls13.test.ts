import { setTimeout } from "timers/promises";

import {
  DtlsVersion,
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  isMedia,
} from "../../src";
import {
  dtlsPeerConfig,
  inspectCookieHelloRetryRequests,
  negotiateWithDtlsCapture,
} from "../fixture";
import {
  awaitMessage,
  createDataChannelPair,
  exchangeIceCandidates,
  exchangeOfferAnswer,
  getTransportStats,
  isProtocolVersionFailure,
  mutateSdpFingerprint,
  waitForConnectionState,
  waitForDtlsState,
} from "../utils";

const V1_2 = DtlsVersion.V1_2;
const V1_3 = DtlsVersion.V1_3;

type VersionCase = {
  name: string;
  a: readonly DtlsVersion[];
  b: readonly DtlsVersion[];
  expected: "DTLS 1.2" | "DTLS 1.3";
};

const successCases: VersionCase[] = [
  { name: "1.3 only", a: [V1_3], b: [V1_3], expected: "DTLS 1.3" },
  {
    name: "1.3 preferred vs 1.3",
    a: [V1_3, V1_2],
    b: [V1_3],
    expected: "DTLS 1.3",
  },
  {
    name: "1.3 preferred vs 1.2",
    a: [V1_3, V1_2],
    b: [V1_2],
    expected: "DTLS 1.2",
  },
  { name: "1.2 only", a: [V1_2], b: [V1_2], expected: "DTLS 1.2" },
];

async function assertTransportVersion(
  pc: RTCPeerConnection,
  expected: "DTLS 1.2" | "DTLS 1.3",
) {
  const transport = await getTransportStats(pc);
  expect(transport?.tlsVersion).toBe(expected);
  if (expected === "DTLS 1.3") {
    expect(transport?.dtlsCipher).toBe("TLS_AES_128_GCM_SHA256");
  }
  expect(transport?.dtlsState).toBe("connected");
  expect(transport?.srtpCipher).toBeDefined();
  return transport;
}

describe("DTLS 1.3 WebRTC opt-in", () => {
  test("default PeerConnection stays DTLS 1.2 and clones protocolVersions", async () => {
    const versions: DtlsVersion[] = [V1_3];
    const pc = new RTCPeerConnection({
      dtls: { protocolVersions: versions, helloRetryRequest: true },
    });
    const pcDefault = new RTCPeerConnection();

    try {
      // Assert: 未指定は 1.2 のまま。配列は defensive copy。
      const defaultConfig = pcDefault.getConfiguration();
      expect(defaultConfig.dtls.protocolVersions).toBeUndefined();
      expect(defaultConfig.dtls.helloRetryRequest).toBeUndefined();

      const cloned = pc.getConfiguration();
      expect(cloned.dtls.protocolVersions).toEqual([V1_3]);
      expect(cloned.dtls.protocolVersions).not.toBe(versions);
      expect(cloned.dtls.helloRetryRequest).toBe(true);
      cloned.dtls.protocolVersions![0] = V1_2;
      expect(pc.getConfiguration().dtls.protocolVersions).toEqual([V1_3]);
    } finally {
      await Promise.allSettled([pc.close(), pcDefault.close()]);
    }
  });

  test("opt-in なしの DataChannel は DTLS 1.2", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig());
    const pc2 = new RTCPeerConnection(dtlsPeerConfig());
    try {
      const [dc1, dc2] = await createDataChannelPair(undefined, pc1, pc2);

      // Act: 複数メッセージを順序どおり送る。
      dc1.send("ping-1");
      dc1.send("ping-2");
      expect(await awaitMessage(dc2)).toBe("ping-1");
      expect(await awaitMessage(dc2)).toBe("ping-2");
      dc2.send("pong");
      expect(await awaitMessage(dc1)).toBe("pong");

      // Assert: FEFC にならない。
      await assertTransportVersion(pc1, "DTLS 1.2");
      await assertTransportVersion(pc2, "DTLS 1.2");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });

  test.each(successCases)(
    "version matrix $name",
    async ({ a, b, expected }) => {
      const pc1 = new RTCPeerConnection(dtlsPeerConfig(a));
      const pc2 = new RTCPeerConnection(dtlsPeerConfig(b));
      try {
        const [dc1, dc2] = await createDataChannelPair(undefined, pc1, pc2);

        // Act: DataChannel ping/pong。
        dc1.send("1");
        dc1.send("2");
        dc1.send("3");
        expect(await awaitMessage(dc2)).toBe("1");
        expect(await awaitMessage(dc2)).toBe("2");
        expect(await awaitMessage(dc2)).toBe("3");
        dc2.send("ack");
        expect(await awaitMessage(dc1)).toBe("ack");

        // Assert: negotiated version / cipher / role。
        const stats1 = await assertTransportVersion(pc1, expected);
        const stats2 = await assertTransportVersion(pc2, expected);
        expect(stats1?.dtlsRole).toBe("server");
        expect(stats2?.dtlsRole).toBe("client");
        expect(pc1.connectionState).toBe("connected");
        expect(pc2.connectionState).toBe("connected");
      } finally {
        await Promise.allSettled([pc1.close(), pc2.close()]);
      }
    },
    20_000,
  );

  test("DTLS 1.3 は offerer=client / answerer=server でも成立する", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    try {
      const dc1 = pc1.createDataChannel("dc");
      const opened = Promise.all([
        new Promise<void>((resolve, reject) => {
          dc1.onopen = () => resolve();
          dc1.onerror = ({ error }) => reject(error);
        }),
        new Promise<void>((resolve, reject) => {
          pc2.ondatachannel = ({ channel }) => {
            channel.onopen = () => resolve();
            channel.onerror = ({ error }) => reject(error);
            channel.onmessage = ({ data }) => {
              channel.send(String(data) + "-pong");
            };
          };
        }),
      ]);

      exchangeIceCandidates(pc1, pc2);
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      // Act: answer 前に server を固定し setup:passive にする。
      pc2.dtlsTransports[0].role = "server";
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
      await opened;

      dc1.send("ping");
      expect(await awaitMessage(dc1)).toBe("ping-pong");

      // Assert: 既定とは逆の DTLS role。
      const stats1 = await assertTransportVersion(pc1, "DTLS 1.3");
      const stats2 = await assertTransportVersion(pc2, "DTLS 1.3");
      expect(stats1?.dtlsRole).toBe("client");
      expect(stats2?.dtlsRole).toBe("server");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 20_000);

  test("1.3-only vs 1.2-only は ProtocolVersionError で失敗する", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_2]));
    try {
      pc1.createDataChannel("dc");
      exchangeIceCandidates(pc1, pc2);
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);

      // Act: timeout ではなく failed を待つ。
      await Promise.race([
        waitForConnectionState(pc1, "failed", 5_000),
        waitForConnectionState(pc2, "failed", 5_000),
      ]);

      // Assert: protocol_version が診断できる。
      const dtlsFailed = [pc1, pc2]
        .flatMap((pc) => pc.dtlsTransports)
        .filter((dtls) => dtls.state === "failed");
      expect(dtlsFailed.length).toBeGreaterThan(0);
      expect(
        dtlsFailed.some((dtls) => isProtocolVersionFailure(dtls.lastError)),
      ).toBe(true);
      expect(
        pc1.connectionState === "failed" || pc2.connectionState === "failed",
      ).toBe(true);
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 15_000);

  test("DTLS 1.3 で RTP / RTCP が双方向に通る", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const track1 = new MediaStreamTrack({ kind: "video" });
    const track2 = new MediaStreamTrack({ kind: "video" });
    try {
      const transceiver1 = pc1.addTransceiver(track1);
      const transceiver2 = pc2.addTransceiver(track2);
      const rtpFrom2 = new Promise<Buffer>((resolve) => {
        transceiver1.onTrack.subscribe((track) => {
          track.onReceiveRtp.subscribe((rtp) => resolve(rtp.payload));
        });
      });
      const rtpFrom1 = new Promise<Buffer>((resolve) => {
        transceiver2.onTrack.subscribe((track) => {
          track.onReceiveRtp.subscribe((rtp) => resolve(rtp.payload));
        });
      });

      exchangeIceCandidates(pc1, pc2);
      await exchangeOfferAnswer(pc1, pc2);
      await waitForConnectionState(pc1, "connected", 10_000);

      let rtcp1 = 0;
      let rtcp2 = 0;
      pc1.dtlsTransports[0].onRtcp.subscribe(() => {
        rtcp1++;
      });
      pc2.dtlsTransports[0].onRtcp.subscribe(() => {
        rtcp2++;
      });

      // Act: 双方向 RTP を流す。
      const write = (track: MediaStreamTrack, payload: string) => {
        const packet = new RtpPacket(
          new RtpHeader(),
          Buffer.from(payload),
        ).serialize();
        expect(isMedia(packet)).toBe(true);
        track.writeRtp(packet);
      };
      write(track1, "pc1");
      write(track2, "pc2");

      expect(await rtpFrom1).toEqual(Buffer.from("pc1"));
      expect(await rtpFrom2).toEqual(Buffer.from("pc2"));

      const started = Date.now();
      while (rtcp1 === 0 || rtcp2 === 0) {
        if (Date.now() - started > 8_000) {
          throw new Error(`RTCP が双方向に届かない pc1=${rtcp1} pc2=${rtcp2}`);
        }
        write(track1, "pc1");
        write(track2, "pc2");
        await setTimeout(200);
      }

      // Assert: version と SRTP、RTCP。
      await assertTransportVersion(pc1, "DTLS 1.3");
      await assertTransportVersion(pc2, "DTLS 1.3");
      expect(rtcp1).toBeGreaterThan(0);
      expect(rtcp2).toBeGreaterThan(0);
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 20_000);

  test("DTLS 1.3 fingerprint mismatch は接続を失敗させる", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    try {
      pc1.createDataChannel("dc");
      exchangeIceCandidates(pc1, pc2);
      await pc1.setLocalDescription(await pc1.createOffer());
      // Act: offer の fingerprint を改ざんして answerer に渡す。
      await pc2.setRemoteDescription({
        type: "offer",
        sdp: mutateSdpFingerprint(pc1.localDescription!.sdp),
      });
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);

      await waitForDtlsState(pc2.dtlsTransports[0], "failed", 10_000);

      // Assert: SCTP/media を公開せず failed。
      expect(pc2.dtlsTransports[0].state).toBe("failed");
      expect(pc2.dtlsTransports[0].lastError?.message).toMatch(/fingerprint/i);
      expect(pc2.connectionState).not.toBe("connected");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 20_000);

  test("ICE restart 後も DTLS 1.3 association を再利用する", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    try {
      const [dc1, dc2] = await createDataChannelPair(undefined, pc1, pc2);
      await assertTransportVersion(pc1, "DTLS 1.3");
      dc1.send("before");
      expect(await awaitMessage(dc2)).toBe("before");
      const dtlsId = pc1.dtlsTransports[0].id;

      // Act: ICE restart。DTLS 再 handshake はしない（既存 association 継続）。
      await pc1.setLocalDescription(
        await pc1.createOffer({ iceRestart: true }),
      );
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);

      // Assert: 同じ DTLS transport / 1.3 / DataChannel が残る。
      expect(pc1.dtlsTransports[0].id).toBe(dtlsId);
      expect(pc1.dtlsTransports[0].state).toBe("connected");
      expect(pc1.dtlsTransports[0].iceTransport.iceRestarts).toBeGreaterThan(0);
      expect(dc1.readyState).toBe("open");
      expect(dc2.readyState).toBe("open");
      await assertTransportVersion(pc1, "DTLS 1.3");
      await assertTransportVersion(pc2, "DTLS 1.3");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 20_000);

  test("既定の DTLS 1.3 は cookie 付き HRR を送らない", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_3]));
    try {
      pc1.createDataChannel("dc");
      const { answererDatagrams } = await negotiateWithDtlsCapture(pc1, pc2);
      await waitForConnectionState(pc1, "connected", 10_000);

      // Assert: 最初の server handshake は cookie HRR ではない。
      const cookieHrr = inspectCookieHelloRetryRequests(
        answererDatagrams,
      ).filter((hit) => hit.hasCookie);
      expect(cookieHrr).toHaveLength(0);
      await assertTransportVersion(pc1, "DTLS 1.3");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 20_000);

  test("helloRetryRequest: true では cookie 付き HRR の後に接続できる", async () => {
    const pc1 = new RTCPeerConnection(dtlsPeerConfig([V1_3], true));
    const pc2 = new RTCPeerConnection(dtlsPeerConfig([V1_3], true));
    try {
      const dc1 = pc1.createDataChannel("dc");
      const opened = Promise.all([
        new Promise<void>((resolve, reject) => {
          dc1.onopen = () => resolve();
          dc1.onerror = ({ error }) => reject(error);
        }),
        new Promise<void>((resolve, reject) => {
          pc2.ondatachannel = ({ channel }) => {
            channel.onopen = () => resolve();
            channel.onerror = ({ error }) => reject(error);
            channel.onmessage = ({ data }) => {
              channel.send(String(data) + "-pong");
            };
          };
        }),
      ]);
      const { answererDatagrams } = await negotiateWithDtlsCapture(pc1, pc2);
      await opened;

      dc1.send("hrr");
      expect(await awaitMessage(dc1)).toBe("hrr-pong");

      // Assert: cookie 付き HRR → 接続成功。
      const cookieHrr = inspectCookieHelloRetryRequests(
        answererDatagrams,
      ).filter((hit) => hit.hasCookie);
      expect(cookieHrr.length).toBeGreaterThan(0);
      await assertTransportVersion(pc1, "DTLS 1.3");
      await assertTransportVersion(pc2, "DTLS 1.3");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 20_000);
});
