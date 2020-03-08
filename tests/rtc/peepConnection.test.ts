import { RTCPeerConnection } from "../../src";

describe("peerConnection", () => {
  test(
    "test_connect_datachannel_modern_sdp",
    async () => {
      const pc1 = new RTCPeerConnection({});
      const pc2 = new RTCPeerConnection({});

      const dc = pc1.createDataChannel("chat", { protocol: "bob" });

      const offer = (await pc1.createOffer())!;
      expect(offer.type).toBe("offer");
      expect(offer.sdp.includes("m=application")).toBeTruthy();
      expect(offer.sdp.includes("a=candidate")).toBeFalsy();
      expect(offer.sdp.includes("a=end-of-candidates")).toBeFalsy();

      await pc1.setLocalDescription(offer);
      expect(pc1.iceConnectionState).toBe("new");
      expect(pc1.iceGatheringState).toBe("complete");
      const pc1Local = pc1.localDescription!.sdp;
      expect(pc1Local.includes("m=application ")).toBeTruthy();
      expect(pc1Local.includes("a=sctp-port:5000")).toBeTruthy();
      assertHasIceCandidate(pc1Local);
      assertHasDtls(pc1Local, "actpass");

      await pc2.setRemoteDescription(pc1.localDescription!);
      const pc2Remote = pc2.remoteDescription!.sdp;
      expect(pc2Remote).toBe(pc1Local);

      const answer = pc2.createAnswer()!;
      expect(answer.sdp.includes("m=application")).toBeTruthy();
      expect(answer.sdp.includes("a=candidate")).toBeFalsy();
      expect(answer.sdp.includes("a=end-of-candidates")).toBeFalsy();

      await pc2.setLocalDescription(answer);
      expect(pc2.iceConnectionState).toBe("checking");
      expect(pc2.iceGatheringState).toBe("complete");
      const pc2Local = pc2.localDescription!.sdp;
      expect(pc2Local.includes("m=application ")).toBeTruthy();
      expect(pc2Local.includes("a=sctp-port:5000")).toBeTruthy();
      assertHasIceCandidate(pc2Local);
      assertHasDtls(pc2Local, "active");

      await pc1.setRemoteDescription(pc2.localDescription!);
      const pc1Remote = pc1.remoteDescription!.sdp;
      expect(pc1Remote).toBe(pc2Local);
    },
    60 * 1000
  );
});

function assertHasIceCandidate(sdp: string) {
  expect(sdp.includes("a=candidate:")).toBeTruthy();
  expect(sdp.includes("a=end-of-candidates")).toBeTruthy();
}

function assertHasDtls(sdp: string, setup: string) {
  expect(sdp.includes("a=fingerprint:sha-256")).toBeTruthy();
  expect(sdp.includes("a=setup:" + setup)).toBeTruthy();
}
