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
    sendFirefoxSimulcastWithRepair(route);

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
      sdp: firefoxSimulcastSdp({ type: "answer" }),
    });

    expectRidTracksRepair(tracks, transceiver, routeOf(pc, transceiver));
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
      sdp: firefoxSimulcastSdp({ type: "offer" }),
    });
    await pc.setLocalDescription(await pc.createAnswer());

    const [transceiver] = pc.getTransceivers();
    expectRidTracksRepair(tracks, transceiver, routeOf(pc, transceiver));
  });
});
