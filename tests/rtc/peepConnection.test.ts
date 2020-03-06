import { RTCPeerConnection } from "../../src";

describe("peerConnection", () => {
  test("test_connect_datachannel_modern_sdp", async () => {
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
  });
});
