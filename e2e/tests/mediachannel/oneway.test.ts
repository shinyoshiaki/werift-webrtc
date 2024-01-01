import { peer, sleep, waitVideoPlay } from "../fixture";

describe("mediachannel_oneway", () => {
  it(
    "answer",
    async () =>
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

        const offer = await peer.request("mediachannel_oneway_answer", {
          type: "init",
        });
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());

        pc.onicecandidate = ({ candidate }) => {
          peer
            .request("mediachannel_oneway_answer", {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        peer
          .request("mediachannel_oneway_answer", {
            type: "answer",
            payload: pc.localDescription,
          })
          .catch(() => {});
      }),
    10 * 1000,
  );

  it(
    "offer",
    async () =>
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
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request("mediachannel_oneway_offer", {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const [track] = (
          await navigator.mediaDevices.getUserMedia({ video: true })
        ).getTracks();
        pc.addTransceiver(track, { direction: "sendonly" });
        pc.addTransceiver("video", { direction: "recvonly" });

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request("mediachannel_oneway_offer", {
          type: "init",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }),
    10 * 1000,
  );
});
