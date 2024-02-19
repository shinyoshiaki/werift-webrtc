import { peer, sleep, waitVideoPlay } from "../fixture";

describe("mediachannel_sendrecv", () => {
  it("mediachannel_sendrecv_answer", async () =>
    new Promise<void>(async (done) => {
      const label = "mediachannel_sendrecv_answer";

      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.ontrack = async ({ track }) => {
        await waitVideoPlay(track);
        pc.close();
        done();
      };

      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      pc.addTrack(track);

      const offer = await peer.request(label, {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };

      peer
        .request(label, {
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
      pc.ontrack = async ({ track }) => {
        await waitVideoPlay(track);
        pc.close();
        done();
      };
      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      pc.addTrack(track);
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request("mediachannel_sendrecv_offer", {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request("mediachannel_sendrecv_offer", {
        type: "init",
        payload: pc.localDescription,
      });
      await pc.setRemoteDescription(answer);
    }));
});
