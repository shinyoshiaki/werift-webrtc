import { peer, sleep } from "../fixture";

describe("datachannel", () => {
  it("answer", async () =>
    new Promise<void>(async (done) => {
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const offer = await peer.request("datachannel_answer", {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => {
          expect(data).toBe("ping" + "pong");
          pc.close();
          done();
        };
        channel.send("ping");
      };

      pc.onicecandidate = ({ candidate }) => {
        peer
          .request("datachannel_answer", {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };

      peer
        .request("datachannel_answer", {
          type: "answer",
          payload: pc.localDescription,
        })
        .catch(() => {});
    }));

  it("offer", async () =>
    new Promise<void>(async (done) => {
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const channel = pc.createDataChannel("dc");
      channel.onopen = () => {
        channel.send("ping");
      };
      channel.onmessage = ({ data }) => {
        expect(data).toBe("ping" + "pong");
        done();
      };
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request("datachannel_offer", {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request("datachannel_offer", {
        type: "init",
        payload: pc.localDescription,
      });
      await pc.setRemoteDescription(answer);
    }));
});
