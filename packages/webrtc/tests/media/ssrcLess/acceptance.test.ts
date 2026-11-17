import { describe, expect, test, vi } from "vitest";

import { inboundRtpSsrcs } from "./arrange";
import { answerRingCentral, connectWithoutSsrc } from "./peers";

/**
 * Acceptance test of ticket e7d0e0c9 (#356): RTP from a peer whose SDP has no
 * `a=ssrc` (and no MID / RID extension) used to be dropped as "ssrcReceiver not
 * found"; now it reaches the track `ontrack` announced, from the first packet,
 * with RTCP and stats following the learned SSRC. Uses the reported
 * RingCentral offer, and two real werift peers over ICE / DTLS / SRTP whose
 * offer has `a=ssrc` and the MID extension removed.
 */
describe("acceptance: RTP of an m-line without a=ssrc reaches the announced track", () => {
  test("(RingCentral offer) 3.2・3.3・3.4: 初回パケットから ontrack の track に届き、SSRC が変わっても同じ track に届き続ける", async () => {
    const { pc, announced, transceiver, dtls, payloads, rtp } =
      await answerRingCentral();

    try {
      // Assert: SDP に SSRC がないので、通知済みの track は SSRC を持たない (前提)。
      expect(announced).toHaveLength(1);
      expect(announced[0].ssrc).toBeUndefined();

      // Act: MID / RID 拡張なしの PCMU (PT 0) を、SDP にない SSRC で流す。
      dtls.onRtp.execute(rtp(0x1234, 0, 1));
      dtls.onRtp.execute(rtp(0x1234, 0, 2));

      // Assert: 初回パケットから通知済みの track に届き、track がその SSRC を持つ。
      expect(payloads).toEqual(["pt0-1", "pt0-2"]);
      expect(announced[0].ssrc).toBe(0x1234);

      // Act: 相手が SSRC を切り替える (SIP の re-INVITE やメディアサーバの切替)。
      dtls.onRtp.execute(rtp(0x9999, 0, 3));

      // Assert: 新しい SSRC も同じ track に届き、ontrack は再発火しない。
      expect(payloads).toEqual(["pt0-1", "pt0-2", "pt0-3"]);
      expect(announced).toHaveLength(1);
      expect(transceiver.receiver.track).toBe(announced[0]);
      expect(announced[0].ssrc).toBe(0x9999);
    } finally {
      await pc.close();
    }
  });

  test("(werift 同士、BUNDLE) 3.2・3.3: a=ssrc と MID のない audio と video が実際の接続でそれぞれの track に届き、SR と統計も追従する", async () => {
    const {
      pc2,
      announced,
      received,
      reportsFrom,
      senderSsrcs,
      sendAll,
      close,
    } = await connectWithoutSsrc(["audio", "video"]);

    try {
      // Act: SSRC も MID もない状態で、両方の track からメディアを送る。
      await sendAll(10);

      // Assert: 各 ontrack の track に、自分の m-line の RTP だけが届く。
      expect(announced.map((t) => t.kind)).toEqual(["audio", "video"]);
      expect(received.map((p) => new Set(p))).toEqual([
        new Set(["audio0"]),
        new Set(["video1"]),
      ]);

      // Assert: 相手の SR が学習した SSRC で同じ track に届く。
      await vi.waitFor(
        () =>
          expect(reportsFrom.map((r) => r.includes(senderSsrcs[0]))).toEqual([
            true,
            false,
          ]),
        { timeout: 5000 },
      );

      // Assert: getStats の inbound-rtp に学習した SSRC が出る。
      const [audio, video] = pc2.getTransceivers();
      expect(await inboundRtpSsrcs(audio)).toEqual([senderSsrcs[0]]);
      expect(await inboundRtpSsrcs(video)).toEqual([senderSsrcs[1]]);
    } finally {
      await close();
    }
  });

  test("(werift 同士、BUNDLE) 3.2: PT が重なる 2 本の audio は推測せず、どちらにも届けない", async () => {
    const { announced, received, sendAll, close } = await connectWithoutSsrc([
      "audio",
      "audio",
    ]);

    try {
      // Act: 同じ transport 上で、受信先を PT で決められない 2 本を送る。
      await sendAll(10);

      // Assert: 両方の track が通知されているが、誤配送せずどちらにも届かない。
      expect(announced).toHaveLength(2);
      expect(received).toEqual([[], []]);
    } finally {
      await close();
    }
  });

  test("(werift 同士、transport 別) 3.7・3.8: 同じ PT の 2 本の audio も、RTP session が分かれていればそれぞれの track に届く", async () => {
    const { announced, received, sendAll, close } = await connectWithoutSsrc(
      ["audio", "audio"],
      { bundlePolicy: "disable" },
    );

    try {
      // Act: m-line ごとに別の transport で、同じ PT の 2 本を送る。
      await sendAll(10);

      // Assert: PT の一意性は RTP session ごとに判定され、各 track に自分の RTP だけが届く。
      expect(announced).toHaveLength(2);
      expect(received.map((p) => new Set(p))).toEqual([
        new Set(["audio0"]),
        new Set(["audio1"]),
      ]);
    } finally {
      await close();
    }
  });
});
