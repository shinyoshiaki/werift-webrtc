import { waitVideoPlay, peer, sleep } from "../fixture";

describe("mediachannel_sendrecv", () => {
  it(
    "answer",
    async (done) => {
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.ontrack = ({ track }) => {
        waitVideoPlay(track).then(done);
      };

      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      pc.addTrack(track);

      const offer = await peer.request("mediachannel_sendrecv_answer", {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.onicecandidate = ({ candidate }) => {
        peer.request("mediachannel_sendrecv_answer", {
          type: "candidate",
          payload: candidate,
        });
      };

      peer.request("mediachannel_sendrecv_answer", {
        type: "answer",
        payload: pc.localDescription,
      });
    },
    10 * 1000
  );

  it(
    "offer",
    async (done) => {
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.ontrack = ({ track }) => {
        waitVideoPlay(track).then(done);
      };
      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      pc.addTrack(track);
      pc.onicecandidate = ({ candidate }) => {
        peer.request("mediachannel_sendrecv_offer", {
          type: "candidate",
          payload: candidate,
        });
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request("mediachannel_sendrecv_offer", {
        type: "init",
        payload: pc.localDescription,
      });
      await pc.setRemoteDescription(answer);
    },
    10 * 1000
  );
});
