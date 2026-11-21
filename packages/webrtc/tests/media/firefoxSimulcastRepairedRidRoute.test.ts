import { describe, expect, test, vi } from "vitest";
import type { RTCRtpReceiver } from "../../src";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxFor,
  firefoxSimulcastLayers,
  firefoxSimulcastOfferWithFid,
  receiveFirefoxSimulcastOffer,
  retransmissionsOf,
} from "./rtpReceiverTestUtils";

/**
 * The router hands an RTX packet that is already routed to a RID receiver by
 * its SSRC, and names a repaired RID, to that RID only when
 * `RTCRtpReceiver.readsRepairedRid` says so: the SSRC is the RTX SSRC of a
 * committed FID pair, or no RID, track or SDP RTX pair claims it. An RTX SSRC
 * a repaired RID already bound keeps its RID, and a RID without a track is
 * never read.
 */
describe("simulcast (RID) RTX routed by SSRC with a repaired RID (readsRepairedRid)", () => {
  const [high, low] = firefoxSimulcastLayers;
  const rtxSsrc = high.rtxSsrc;

  /** Arrange: a receiving peer, holes 4 in both layers and a spy on the router predicate. */
  const arrange = async (fidPairs: [number, number][]) => {
    const session = await receiveFirefoxSimulcastOffer(
      firefoxSimulcastOfferWithFid(fidPairs),
    );
    const receiver = session.pc.getTransceivers()[0].receiver as RTCRtpReceiver;
    const reads = vi.spyOn(receiver, "readsRepairedRid");
    const delivered = {
      high: session.deliveredOf("high"),
      low: session.deliveredOf("low"),
    };
    for (const layer of firefoxSimulcastLayers) {
      for (const sequenceNumber of [1, 3, 5]) {
        session.route(
          createSimulcastMediaPacket({
            ssrc: layer.ssrc,
            sequenceNumber,
            rid: layer.rid,
            mid: "0",
          }),
        );
      }
    }
    const repair = (
      mediaSsrc: number,
      sequenceNumber: number,
      rtxSequenceNumber: number,
      rrid?: string,
    ) =>
      createSimulcastRtxFor(mediaSsrc, sequenceNumber, {
        rtxSsrc,
        rtxSequenceNumber,
        rrid,
        mid: "0",
      });
    const restored = () => ({
      high: retransmissionsOf(delivered.high),
      low: retransmissionsOf(delivered.low),
    });
    return { ...session, receiver, reads, repair, restored };
  };

  test("確定で FID の組が外れて RID にも SDP にも帰属しない RTX SSRC は、SSRC で届いても repaired RID が指す RID のトラックへ復元される", async () => {
    // Arrange: RTX SSRC を high の媒体と FID で組にした offer を確定し、その組を外した再 offer を確定する。
    const { pc, route, remoteOffer, receiver, reads, repair, restored } =
      await arrange([[high.ssrc, rtxSsrc]]);
    try {
      await remoteOffer(firefoxSimulcastOfferWithFid([]));
      expect(receiver.readsRepairedRid(rtxSsrc, "low")).toBe(true);
      reads.mockClear();

      // Act: その RTX SSRC から、repaired RID low を付けて low の欠落 4 を再送する。
      route(repair(low.ssrc, 4, 1, "low"));

      // Assert: router は readsRepairedRid の経路を通り、low の欠落 4 だけが low のトラックへ復元される。
      expect(reads).toHaveReturnedWith(true);
      expect(restored()).toEqual({ high: [], low: [[low.ssrc, 4]] });
    } finally {
      await pc.close();
    }
  });

  test("確定済みの FID の RTX SSRC は、repaired RID 付きでも従来どおりその RID のトラックへ復元される", async () => {
    // Arrange: RTX SSRC を high の媒体と FID で組にした offer を確定する。
    const { pc, route, reads, repair, restored } = await arrange([
      [high.ssrc, rtxSsrc],
    ]);
    try {
      // Act: FID の RTX SSRC から repaired RID high を付けて high の欠落 4 を再送する。
      route(repair(high.ssrc, 4, 1, "high"));

      // Assert: high の欠落 4 だけが high のトラックへ復元される。
      expect(reads).toHaveReturnedWith(true);
      expect(restored()).toEqual({ high: [[high.ssrc, 4]], low: [] });
    } finally {
      await pc.close();
    }
  });

  test("FID のない記述で repaired RID により high に学習した RTX SSRC は、別の repaired RID を付けて届いても high に結び付いたままになる", async () => {
    // Arrange: FID のない (Chrome 形式の) offer で、repaired RID high により RTX SSRC を high に学習させる。
    const { pc, route, receiver, reads, repair, restored } = await arrange([]);
    try {
      route(repair(high.ssrc, 2, 1, "high"));
      reads.mockClear();

      // Act: 学習済みの RTX SSRC から、repaired RID low を付けて high の欠落 4 と low の欠落 4 を再送する。
      route(repair(high.ssrc, 4, 2, "low"));
      route(repair(low.ssrc, 4, 3, "low"));

      // Assert: readsRepairedRid は経路を変えず、学習した high の欠落だけが high のトラックへ復元される。
      expect(reads).toHaveReturnedWith(false);
      expect(receiver.readsRepairedRid(rtxSsrc, "low")).toBe(false);
      expect(restored()).toEqual({
        high: [
          [high.ssrc, 2],
          [high.ssrc, 4],
        ],
        low: [],
      });
    } finally {
      await pc.close();
    }
  });

  test("トラックのない RID を repaired RID に付けた RTX は、readsRepairedRid の経路で RID 扱いされない", async () => {
    // Arrange: RTX SSRC を high の媒体と FID で組にした offer を確定する。
    const { pc, receiver } = await arrange([[high.ssrc, rtxSsrc]]);
    try {
      // Act / Assert: トラックのない RID では、FID の RTX SSRC でも未学習の SSRC でも false になる。
      expect(receiver.readsRepairedRid(rtxSsrc, "unknown")).toBe(false);
      expect(receiver.readsRepairedRid(424242, "unknown")).toBe(false);
    } finally {
      await pc.close();
    }
  });
});
