import { afterEach, describe, expect, test } from "vitest";
import type {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpTransceiver,
  RtpPacket,
} from "../../src";
import type { RtpRouter } from "../../src/media/router";
import {
  collectDeliveredRtp,
  createFirefoxSimulcastReceivingPeer,
  createSimulcastMediaPacket,
  createSimulcastRtxFor,
  firefoxSimulcastLayers,
  firefoxSimulcastSdp,
  retransmissionsOf,
  sendFirefoxSimulcastWithRepair,
} from "./rtpReceiverTestUtils";

/**
 * Simulcast received by RID from a description that also lists each layer's
 * SSRCs (`a=ssrc` / `a=ssrc-group:FID`, as Firefox writes it): only the RID
 * tracks exist, and every layer's RTX repairs onto its RID track.
 */
describe("simulcast (RID) receive with a=ssrc / ssrc-group:FID (Firefox)", () => {
  const peers: RTCPeerConnection[] = [];
  afterEach(async () => {
    await Promise.all(peers.splice(0).map((pc) => pc.close()));
  });

  const routeOf = (pc: RTCPeerConnection, transceiver: RTCRtpTransceiver) => {
    const { router } = pc as unknown as { router: RtpRouter };
    return (packet: RtpPacket) =>
      router.routeRtp(packet, transceiver.dtlsTransport);
  };

  /** Assert: the RID tracks only, each repairing its own layer. */
  const expectRidTracksRepair = (
    tracks: MediaStreamTrack[],
    transceiver: RTCRtpTransceiver,
    route: (packet: RtpPacket) => void,
    repairedRid = true,
  ) => {
    // Assert: onTrack は RID の数 (high / low) だけ発火し、SSRC のトラックはない。
    expect(tracks.map((t) => [t.rid, t.ssrc])).toEqual([
      ["high", undefined],
      ["low", undefined],
    ]);
    expect(transceiver.receiver.tracks).toEqual(tracks);
    expect(Object.keys(transceiver.receiver.trackBySSRC)).toEqual([]);

    const delivered = Object.fromEntries(
      tracks.map((t) => [t.rid!, collectDeliveredRtp(t)]),
    );

    // Act: 各レイヤーが seq 1, 3 を RID 付きで送り、落ちた seq 2 を rrid 付き RTX で再送する。
    sendFirefoxSimulcastWithRepair(route, "0", { repairedRid });

    // Assert: 両レイヤーとも、復元パケットは元の媒体 SSRC / seq で同じ RID のトラックに届く。
    for (const layer of firefoxSimulcastLayers) {
      expect(delivered[layer.rid].map((p) => [p.ssrc, p.seq])).toEqual([
        [layer.ssrc, 1],
        [layer.ssrc, 3],
        [layer.ssrc, 2],
      ]);
      expect(retransmissionsOf(delivered[layer.rid])).toEqual([
        [layer.ssrc, 2],
      ]);
    }
  };

  describe.each([
    ["制約なしの RID", undefined, true],
    ["制約付きの RID (max-width)", "max-width=1280", true],
    ["repaired RID 拡張なし (FID だけで RTX を対応付ける)", undefined, false],
  ])("%s", (_name, ridRestrictions, repairedRid) => {
    test("werift の offer に対する Firefox の answer でも、トラックは RID ごとの 1 本だけで、両レイヤーの RTX は RID のトラックへ復元される", async () => {
      // Arrange
      const pc = createFirefoxSimulcastReceivingPeer();
      peers.push(pc);
      const transceiver = pc.addTransceiver("video", {
        direction: "recvonly",
        simulcast: [
          { rid: "high", direction: "recv" },
          { rid: "low", direction: "recv" },
        ],
      });
      const tracks: MediaStreamTrack[] = [];
      transceiver.onTrack.subscribe((track) => tracks.push(track));
      await pc.setLocalDescription(await pc.createOffer());

      // Act: a=ssrc ×4 と ssrc-group:FID ×2 を持つ Firefox の answer を適用する。
      await pc.setRemoteDescription({
        type: "answer",
        sdp: firefoxSimulcastSdp({
          type: "answer",
          ridRestrictions,
          repairedRidExtension: repairedRid,
        }),
      });

      expectRidTracksRepair(
        tracks,
        transceiver,
        routeOf(pc, transceiver),
        repairedRid,
      );
    });

    test("Firefox の offer を受けても、トラックは RID ごとの 1 本だけで、両レイヤーの RTX は RID のトラックへ復元される", async () => {
      // Arrange
      const pc = createFirefoxSimulcastReceivingPeer();
      peers.push(pc);
      const tracks: MediaStreamTrack[] = [];
      pc.onTransceiverAdded.subscribe((transceiver) =>
        transceiver.onTrack.subscribe((track) => tracks.push(track)),
      );

      // Act: a=ssrc ×4 と ssrc-group:FID ×2 を持つ Firefox の offer を適用し、answer を確定する。
      await pc.setRemoteDescription({
        type: "offer",
        sdp: firefoxSimulcastSdp({
          type: "offer",
          ridRestrictions,
          repairedRidExtension: repairedRid,
        }),
      });
      await pc.setLocalDescription(await pc.createAnswer());

      const [transceiver] = pc.getTransceivers();
      expectRidTracksRepair(
        tracks,
        transceiver,
        routeOf(pc, transceiver),
        repairedRid,
      );
    });
  });
});

describe("simulcast a=rid restrictions in the answer", () => {
  test("制約付き RID の offer への answer は recv を返し、offer 側がその answer を適用できる", async () => {
    // Arrange: 送信側が simulcast の offer を作り、その RID 行に制約を付けて受信側へ渡す。
    const sender = createFirefoxSimulcastReceivingPeer();
    const receiver = createFirefoxSimulcastReceivingPeer();
    try {
      sender.addTransceiver("video", {
        direction: "sendonly",
        simulcast: [
          { rid: "high", direction: "send" },
          { rid: "low", direction: "send" },
        ],
      });
      const offer = await sender.createOffer();
      await sender.setLocalDescription(offer);
      const constrained = offer.sdp.replace(
        /^(a=rid:\w+ send)\r$/gm,
        "$1 max-width=1280\r",
      );
      expect(constrained).toContain("a=rid:high send max-width=1280");

      // Act: 受信側が制約付き offer に answer し、送信側がそれを適用する。
      await receiver.setRemoteDescription({ type: "offer", sdp: constrained });
      const answer = await receiver.createAnswer();
      await receiver.setLocalDescription(answer);
      await sender.setRemoteDescription(answer);

      // Assert: answer の RID は recv で、制約は含まず、送信側に適用されている。
      expect(answer.sdp).toContain("a=rid:high recv\r\n");
      expect(answer.sdp).toContain("a=rid:low recv\r\n");
      expect(answer.sdp).not.toContain("max-width");
      expect(sender.signalingState).toBe("stable");
    } finally {
      await Promise.all([sender.close(), receiver.close()]);
    }
  });
});

describe("simulcast (RID) receive with a=ssrc-group:FID keeps the RID rules", () => {
  const [high] = firefoxSimulcastLayers;

  /** Arrange: a peer that applied a Firefox offer (FID, no repaired RID extension). */
  const receiveFirefoxOffer = async (repairedRidExtension: boolean) => {
    const pc = createFirefoxSimulcastReceivingPeer();
    const tracks: MediaStreamTrack[] = [];
    pc.onTransceiverAdded.subscribe((transceiver) =>
      transceiver.onTrack.subscribe((track) => tracks.push(track)),
    );
    await pc.setRemoteDescription({
      type: "offer",
      sdp: firefoxSimulcastSdp({ type: "offer", repairedRidExtension }),
    });
    await pc.setLocalDescription(await pc.createAnswer());
    const [transceiver] = pc.getTransceivers();
    const { router } = pc as unknown as { router: RtpRouter };
    const route = (packet: RtpPacket) =>
      router.routeRtp(packet, transceiver.dtlsTransport);
    const delivered = collectDeliveredRtp(
      tracks.find((track) => track.rid === "high")!,
    );
    return { pc, route, delivered };
  };

  const media = (ssrc: number, sequenceNumber: number) =>
    createSimulcastMediaPacket({ ssrc, sequenceNumber, rid: "high", mid: "0" });

  test("媒体 SSRC が SDP の値から切り替わっても、FID の RTX SSRC からの再送は新しい媒体の欠落を復元する", async () => {
    // Arrange
    const { pc, route, delivered } = await receiveFirefoxOffer(true);
    const switched = 123456789;
    try {
      // Act: RID high の媒体 SSRC が切り替わり (1, 3 を受信、2 が欠落)、SDP の RTX SSRC が 2 を再送する。
      route(media(switched, 1));
      route(media(switched, 3));
      route(
        createSimulcastRtxFor(switched, 2, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber: 1,
          rrid: "high",
          mid: "0",
        }),
      );

      // Assert: 新しい媒体 SSRC の seq 2 が復元されて届く。
      expect(retransmissionsOf(delivered)).toEqual([[switched, 2]]);
    } finally {
      await pc.close();
    }
  });

  test("FID の RTX SSRC から、すでに受信済みの番号の遅延 RTX が来ても重複して配送しない", async () => {
    // Arrange
    const { pc, route, delivered } = await receiveFirefoxOffer(false);
    try {
      // Act: 媒体を 1, 3, 2 の順に受信し、その後に番号 2 の RTX が届く。
      route(media(high.ssrc, 1));
      route(media(high.ssrc, 3));
      route(media(high.ssrc, 2));
      route(
        createSimulcastRtxFor(high.ssrc, 2, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber: 1,
          mid: "0",
        }),
      );

      // Assert: 番号 2 は一度だけ届き、再送としては配送されない。
      expect(delivered.map((p) => p.seq)).toEqual([1, 3, 2]);
      expect(retransmissionsOf(delivered)).toEqual([]);
    } finally {
      await pc.close();
    }
  });

  test("旧媒体 SSRC を修復した FID の RTX SSRC は、媒体 SSRC の切り替え後も新しい媒体の欠落を復元する", async () => {
    // Arrange
    const { pc, route, delivered } = await receiveFirefoxOffer(true);
    const switched = 123456789;
    try {
      // Act: SDP の媒体 SSRC の 2 を FID の RTX SSRC で修復した後、媒体 SSRC が切り替わり、同じ RTX SSRC が新しい媒体の 11 を再送する。
      route(media(high.ssrc, 1));
      route(media(high.ssrc, 3));
      route(
        createSimulcastRtxFor(high.ssrc, 2, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber: 1,
          rrid: "high",
          mid: "0",
        }),
      );
      route(media(switched, 10));
      route(media(switched, 12));
      route(
        createSimulcastRtxFor(switched, 11, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber: 2,
          rrid: "high",
          mid: "0",
        }),
      );

      // Assert: 切り替え前の 2 と切り替え後の 11 の両方が復元されて届く。
      expect(retransmissionsOf(delivered)).toEqual([
        [high.ssrc, 2],
        [switched, 11],
      ]);
    } finally {
      await pc.close();
    }
  });

  test("repaired RID がなくても、旧媒体 SSRC を修復した FID の RTX SSRC は、媒体 SSRC の切り替え後に新しい媒体の欠落を復元する", async () => {
    // Arrange: repaired RID 拡張なしの FID 付き offer。
    const { pc, route, delivered } = await receiveFirefoxOffer(false);
    const switched = 123456789;
    const repair = (
      mediaSsrc: number,
      sequenceNumber: number,
      rtxSequenceNumber: number,
    ) =>
      createSimulcastRtxFor(mediaSsrc, sequenceNumber, {
        rtxSsrc: high.rtxSsrc,
        rtxSequenceNumber,
        mid: "0",
      });
    try {
      // Act: 切り替え前に 2 を修復し、媒体 SSRC が切り替わった後に同じ RTX SSRC が 11 を再送する。
      route(media(high.ssrc, 1));
      route(media(high.ssrc, 3));
      route(repair(high.ssrc, 2, 1));
      route(media(switched, 10));
      route(media(switched, 12));
      route(repair(switched, 11, 2));

      // Assert: 切り替え前の 2 と切り替え後の 11 の両方が復元されて届く。
      expect(retransmissionsOf(delivered)).toEqual([
        [high.ssrc, 2],
        [switched, 11],
      ]);
    } finally {
      await pc.close();
    }
  });

  test("repaired RID がなく、切り替え前に RTX を受信していなくても、切り替え後に初めて届いた FID の RTX SSRC は新しい媒体の欠落を復元する", async () => {
    // Arrange: repaired RID 拡張なしの FID 付き offer。
    const { pc, route, delivered } = await receiveFirefoxOffer(false);
    const switched = 123456789;
    try {
      // Act: SDP の媒体 SSRC を受信してから (RTX は未受信) 媒体 SSRC が切り替わり、同じ RTX SSRC が 11 を初めて再送する。
      route(media(high.ssrc, 1));
      route(media(high.ssrc, 2));
      route(media(switched, 10));
      route(media(switched, 12));
      route(
        createSimulcastRtxFor(switched, 11, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber: 1,
          mid: "0",
        }),
      );

      // Assert: 新しい媒体 SSRC の 11 が復元されて届く。
      expect(retransmissionsOf(delivered)).toEqual([[switched, 11]]);
    } finally {
      await pc.close();
    }
  });

  test("保留中の offer が同じ RTX SSRC に別の FID 媒体 SSRC を割り当てても、現行セッションの RTX は復元され、rollback 後も元の対応に戻る", async () => {
    // Arrange: 現行セッションの FID (high.ssrc ↔ high.rtxSsrc) と、同じ RTX SSRC を別の媒体 SSRC と組にした再 offer。
    const { pc, route, delivered } = await receiveFirefoxOffer(false);
    const otherMedia = 987654321;
    const reoffer = firefoxSimulcastSdp({
      type: "offer",
      repairedRidExtension: false,
    }).replace(
      `a=ssrc-group:FID ${high.ssrc} ${high.rtxSsrc}`,
      `a=ssrc-group:FID ${otherMedia} ${high.rtxSsrc}`,
    );
    const repair = (sequenceNumber: number, rtxSequenceNumber: number) =>
      createSimulcastRtxFor(high.ssrc, sequenceNumber, {
        rtxSsrc: high.rtxSsrc,
        rtxSequenceNumber,
        mid: "0",
      });
    try {
      // Act: 再 offer を保留したまま、現行の媒体 1, 3 と 2 の RTX (repaired RID なし) を受信する。
      await pc.setRemoteDescription({ type: "offer", sdp: reoffer });
      expect(pc.signalingState).toBe("have-remote-offer");
      route(media(high.ssrc, 1));
      route(media(high.ssrc, 3));
      route(repair(2, 1));

      // Act: rollback 後に媒体 4, 6 と 5 の RTX を受信する。
      await pc.setRemoteDescription({ type: "rollback", sdp: "" });
      route(media(high.ssrc, 4));
      route(media(high.ssrc, 6));
      route(repair(5, 2));

      // Assert: 保留中も rollback 後も、現行の FID に従って RID high のトラックへ復元される。
      expect(pc.signalingState).toBe("stable");
      expect(retransmissionsOf(delivered)).toEqual([
        [high.ssrc, 2],
        [high.ssrc, 5],
      ]);
    } finally {
      await pc.close();
    }
  });

  test("保留中の offer だけが記述した FID の RTX SSRC は、rollback で経路ごと元に戻る", async () => {
    // Arrange: 現行の FID の RTX SSRC を別の値 (pendingRtx) に替えた再 offer。
    const { pc } = await receiveFirefoxOffer(false);
    const pendingRtx = 2468013579;
    const [transceiver] = pc.getTransceivers();
    const { router } = pc as unknown as {
      router: {
        endpointBySsrc: (ssrc: number, dtls: unknown) => unknown;
      };
    };
    const routed = (ssrc: number) =>
      router.endpointBySsrc(ssrc, transceiver.dtlsTransport) !== undefined;
    const reoffer = firefoxSimulcastSdp({
      type: "offer",
      repairedRidExtension: false,
    }).replace(
      `a=ssrc-group:FID ${high.ssrc} ${high.rtxSsrc}`,
      `a=ssrc-group:FID ${high.ssrc} ${pendingRtx}`,
    );
    try {
      // Act: 再 offer を保留し、続けて rollback する。
      await pc.setRemoteDescription({ type: "offer", sdp: reoffer });
      const pendingRouted = routed(pendingRtx);
      await pc.setRemoteDescription({ type: "rollback", sdp: "" });

      // Assert: 保留中だけ新しい RTX SSRC に経路があり、rollback 後は消えて元の RTX SSRC の経路が残る。
      expect(pendingRouted).toBe(true);
      expect(routed(pendingRtx)).toBe(false);
      expect(routed(high.rtxSsrc)).toBe(true);
    } finally {
      await pc.close();
    }
  });
});
