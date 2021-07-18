import { waitVideoPlay, peer, sleep } from "../fixture";

describe("mediachannel_rtx", () => {
  it(
    "mediachannel_rtx_client_answer",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer.request("mediachannel_rtx_client_answer", {
            type: "candidate",
            payload: candidate,
          });
        };
        pc.ontrack = async ({ track }) => {
          await waitVideoPlay(track);
          await peer.request("mediachannel_rtx_client_answer", {
            type: "done",
          });
          done();
        };

        const offer = await peer.request("mediachannel_rtx_client_answer", {
          type: "init",
        });
        // console.log(offer.sdp);
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());
        // console.log(pc.localDescription.sdp);

        peer.request("mediachannel_rtx_client_answer", {
          type: "answer",
          payload: pc.localDescription,
        });
      }),
    10 * 1000
  );

  it(
    "mediachannel_rtx_client_offer",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.ontrack = async ({ track }) => {
          await waitVideoPlay(track);
          await peer.request("mediachannel_rtx_client_offer", {
            type: "done",
          });
          done();
        };
        pc.onicecandidate = ({ candidate }) => {
          peer.request("mediachannel_rtx_client_offer", {
            type: "candidate",
            payload: candidate,
          });
        };

        pc.addTransceiver("video", { direction: "recvonly" });

        await pc.setLocalDescription(await pc.createOffer());
        console.log(pc.localDescription.sdp);
        const answer = await peer.request("mediachannel_rtx_client_offer", {
          type: "init",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
        console.log(answer.sdp);
      }),
    10 * 1000
  );
});
