import { RTCPeerConnection, RTCDataChannel } from "../src";

describe("peerConnection", () => {
  test("test_connect_datachannel_modern_sdp", async (done) => {
    const pc1 = new RTCPeerConnection({});
    const pc2 = new RTCPeerConnection({});

    pc2.onDataChannel.subscribe((channel) => {
      channel.message.subscribe((data) => {
        expect(data.toString()).toBe("hello");
        done();
      });
    });

    const dc = pc1.createDataChannel("chat", { protocol: "bob" });
    expect(dc.label).toBe("chat");
    expect(dc.maxPacketLifeTime).toBeUndefined();
    expect(dc.maxRetransmits).toBeUndefined();
    expect(dc.ordered).toBeTruthy();
    expect(dc.protocol).toBe("bob");
    expect(dc.readyState).toBe("connecting");

    dc.stateChanged.subscribe((state) => {
      if (state === "open") {
        dc.send(Buffer.from("hello"));
      }
    });

    const offer = await pc1.createOffer()!;
    expect(offer.type).toBe("offer");
    expect(offer.sdp.includes("m=application")).toBeTruthy();
    expect(offer.sdp.includes("a=candidate")).toBeFalsy();
    expect(offer.sdp.includes("a=end-of-candidates")).toBeFalsy();

    await pc1.setLocalDescription(offer);
    expect(pc1.iceConnectionState).toBe("new");
    // expect(pc1.iceGatheringState).toBe("complete");

    expect(pc1.localDescription!.sdp.includes("m=application ")).toBeTruthy();
    expect(pc1.localDescription!.sdp.includes("a=sctp-port:5000")).toBeTruthy();
    assertHasIceCandidate(pc1.localDescription!.sdp);
    assertHasDtls(pc1.localDescription!.sdp, "actpass");

    // # handle offer
    await pc2.setRemoteDescription(pc1.localDescription!);
    expect(pc2.remoteDescription!.sdp).toBe(pc1.localDescription!.sdp);

    // # create answer
    const answer = await pc2.createAnswer()!;
    expect(answer.sdp.includes("m=application")).toBeTruthy();
    // expect(answer.sdp.includes("a=candidate")).toBeFalsy();
    // expect(answer.sdp.includes("a=end-of-candidates")).toBeFalsy();

    await pc2.setLocalDescription(answer);
    // expect(pc2.iceConnectionState).toBe("checking");
    // expect(pc2.iceGatheringState).toBe("complete");
    expect(pc2.localDescription!.sdp.includes("m=application ")).toBeTruthy();
    expect(pc2.localDescription!.sdp.includes("a=sctp-port:5000")).toBeTruthy();
    assertHasIceCandidate(pc2.localDescription!.sdp);
    assertHasDtls(pc2.localDescription!.sdp, "active");

    // # handle answer
    await pc1.setRemoteDescription(pc2.localDescription!);
    expect(pc1.remoteDescription!.sdp).toBe(pc2.localDescription!.sdp);
    expect(pc1.iceConnectionState).toBe("checking");

    await assertIceCompleted(pc1, pc2);

    await assertDataChannelOpen(dc);
    expect(true).toBe(true);
  });

  test("test_close_datachannel", async (done) => {
    const pcOffer = new RTCPeerConnection({});
    const pcAnswer = new RTCPeerConnection({});

    const dc = pcOffer.createDataChannel("chat");

    pcAnswer.onDataChannel.subscribe((channel) => {
      channel.message.subscribe(async (data) => {
        expect(data.toString()).toBe("hello");
        channel.close();
        await Promise.all([
          new Promise<void>((r) => {
            dc.stateChanged.subscribe((state) => {
              if (state === "closed") {
                r();
              }
            });
          }),
          new Promise<void>((r) => {
            channel.stateChanged.subscribe((state) => {
              if (state === "closed") {
                r();
              }
            });
          }),
        ]);
        done();
      });
    });

    dc.stateChanged.subscribe((state) => {
      if (state === "open") {
        dc.send(Buffer.from("hello"));
      }
    });

    const offer = await pcOffer.createOffer()!;
    await pcOffer.setLocalDescription(offer);
    await pcAnswer.setRemoteDescription(pcOffer.localDescription!);

    const answer = await pcAnswer.createAnswer()!;
    await pcAnswer.setLocalDescription(answer);
    await pcOffer.setRemoteDescription(pcAnswer.localDescription!);

    await assertIceCompleted(pcOffer, pcAnswer);
    await assertDataChannelOpen(dc);
  });
});

function assertHasIceCandidate(sdp: string) {
  expect(sdp.includes("a=candidate:")).toBeTruthy();
  expect(sdp.includes("a=end-of-candidates")).toBeTruthy();
}

function assertHasDtls(sdp: string, setup: string) {
  expect(sdp.includes("a=fingerprint:sha-256")).toBeTruthy();
  expect(sdp.includes("a=setup:" + setup)).toBeTruthy();
}

async function assertIceCompleted(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection
) {
  const wait = (pc: RTCPeerConnection) =>
    new Promise<void>((r) => {
      pc.iceConnectionStateChange.subscribe((v) => {
        if (v === "completed") {
          r();
        }
      });
    });

  await Promise.all([wait(pc1), wait(pc2)]);
}

async function assertDataChannelOpen(dc: RTCDataChannel) {
  return new Promise<void>((r) => {
    dc.stateChanged.subscribe((v) => {
      if (v === "open") {
        r();
      }
    });
  });
}
