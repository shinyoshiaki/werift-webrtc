import { RTCPeerConnection } from "../../src";

describe("restartIce", () => {
  it(
    "test",
    () =>
      new Promise<void>(async (done) => {
        const o = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        const a = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        o.onIceCandidate.subscribe((candidate) => {
          a.addIceCandidate(candidate);
        });
        a.onIceCandidate.subscribe((candidate) => {
          o.addIceCandidate(candidate);
        });

        o.createDataChannel("dc");

        const offer = await o.createOffer();
        o.setLocalDescription(offer);
        await a.setRemoteDescription(offer);

        const answer = await a.createAnswer();
        a.setLocalDescription(answer);
        await o.setRemoteDescription(answer);

        if (a.dataChannels.length === 0) {
          await a.onDataChannel.asPromise();
        }

        setTimeout(() => {
          o.dataChannels[0].send(Buffer.from("o"));
        }, 10);
        {
          const res = await a.dataChannels[0].onMessage.asPromise();
          expect(res.toString()).toBe("o");
        }

        o.restartIce();

        {
          const offer = await o.createOffer();
          o.setLocalDescription(offer);
          await a.setRemoteDescription(offer);

          const answer = await a.createAnswer();
          a.setLocalDescription(answer);
          await o.setRemoteDescription(answer);
        }

        setTimeout(() => {
          o.dataChannels[0].send(Buffer.from("o"));
        }, 10);
        {
          const res = await a.dataChannels[0].onMessage.asPromise();
          expect(res.toString()).toBe("o");
        }

        o.close();
        a.close();

        done();
      }),
    600_000,
  );
});
