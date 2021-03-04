import { RTCPeerConnection } from "../../src";

describe("trickle", () => {
  test(
    "half trickle",
    async (done) => {
      // trickle supported by offer only

      const pcOffer = new RTCPeerConnection({
        iceConfig: { stunServer: ["stun.l.google.com", 19302] },
      });
      const pcAnswer = new RTCPeerConnection({
        iceConfig: { stunServer: ["stun.l.google.com", 19302] },
      });
      pcAnswer.onDataChannel.subscribe((dc) => {
        dc.message.subscribe((data) => {
          expect(data.toString()).toBe("hello");
          done();
        });
      });

      pcOffer.onIceCandidate.subscribe((candidate) => {
        pcAnswer.addIceCandidate(candidate.toJSON());
      });

      const dc = pcOffer.createDataChannel("dc");
      dc.stateChanged.subscribe((state) => {
        if (state === "open") {
          dc.send(Buffer.from("hello"));
        }
      });

      pcOffer.setLocalDescription(await pcOffer.createOffer());

      await pcAnswer.setRemoteDescription(pcOffer.localDescription!);
      await pcAnswer.setLocalDescription(await pcAnswer.createAnswer());

      await pcOffer.setRemoteDescription(pcAnswer.localDescription!);
    },
    15 * 1000
  );
});
