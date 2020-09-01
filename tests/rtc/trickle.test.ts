import { RTCPeerConnection } from "../../src";

describe("trickle", () => {
  test(
    "half trickle",
    async (done) => {
      // trickle supported by offer only

      const pcOffer = new RTCPeerConnection({
        stunServer: ["stun.l.google.com", 19302],
      });
      const pcAnswer = new RTCPeerConnection({
        stunServer: ["stun.l.google.com", 19302],
      });
      pcAnswer.datachannel.subscribe((dc) => {
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

      const offer = pcOffer.createOffer();
      pcOffer.setLocalDescription(offer);

      await pcAnswer.setRemoteDescription(pcOffer.localDescription);
      const answer = pcAnswer.createAnswer();
      await pcAnswer.setLocalDescription(answer);

      await pcOffer.setRemoteDescription(pcAnswer.localDescription);
    },
    15 * 1000
  );
});
