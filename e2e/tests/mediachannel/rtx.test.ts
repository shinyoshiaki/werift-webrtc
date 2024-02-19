import { peer, sleep, waitVideoPlay } from "../fixture";

describe("mediachannel_rtx", () => {
  it("mediachannel_rtx_client_answer", async () =>
    new Promise<void>(async (done) => {
      const label = "mediachannel_rtx_client_answer";
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };
      pc.ontrack = async ({ track }) => {
        await waitVideoPlay(track);
        await peer.request(label, {
          type: "done",
        });
        pc.close();
        done();
      };

      const offer = await peer.request(label, {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      peer
        .request(label, {
          type: "answer",
          payload: pc.localDescription,
        })
        .catch(() => {});
    }));

  it("mediachannel_rtx_client_offer", async () =>
    new Promise<void>(async (done) => {
      const label = "mediachannel_rtx_client_offer";

      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      await peer.request(label, { type: "init" });

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.ontrack = async ({ track }) => {
        await waitVideoPlay(track);
        await peer.request(label, { type: "done" });
        pc.close();
        done();
      };
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, { type: "candidate", payload: candidate })
          .catch(() => {});
      };

      pc.addTransceiver("video", { direction: "recvonly" });

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request(label, {
        type: "offer",
        payload: pc.localDescription,
      });
      await pc.setRemoteDescription(answer);
    }));
});
