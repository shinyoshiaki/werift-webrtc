import { waitVideoPlay, peer, sleep } from "../fixture";

const mediachannel_removetrack_addtrack = "mediachannel_removetrack_addtrack";
const mediachannel_addtrack_removefirst_addtrack =
  "mediachannel_addtrack_removefirst_addtrack";

describe("mediachannel_removeTrack", () => {
  it(
    "removeTrack -> addTrack",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        let offer = await peer.request(mediachannel_removetrack_addtrack, {
          type: "init",
        });

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(mediachannel_removetrack_addtrack, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const answer = async () => {
          await pc.setRemoteDescription(offer);
          await pc.setLocalDescription(await pc.createAnswer());
          peer
            .request(mediachannel_removetrack_addtrack, {
              type: "answer",
              payload: pc.localDescription,
            })
            .catch(() => {});
        };

        answer();
        let track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        offer = await peer.request(mediachannel_removetrack_addtrack, {
          type: "removeTrack",
          payload: 0,
        });
        await answer();

        offer = await peer.request(mediachannel_removetrack_addtrack, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        await peer.request(mediachannel_removetrack_addtrack, {
          type: "done",
        });
        pc.close();
        done();
      }),
    10 * 1000
  );

  it(
    "addTrack -> remove first -> addTrack",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        let offer = await peer.request(
          mediachannel_addtrack_removefirst_addtrack,
          {
            type: "init",
          }
        );

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(mediachannel_addtrack_removefirst_addtrack, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const answer = async () => {
          await pc.setRemoteDescription(offer);
          await pc.setLocalDescription(await pc.createAnswer());
          peer
            .request(mediachannel_addtrack_removefirst_addtrack, {
              type: "answer",
              payload: pc.localDescription,
            })
            .catch(() => {});
        };

        answer();
        let track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        offer = await peer.request(mediachannel_addtrack_removefirst_addtrack, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        offer = await peer.request(mediachannel_addtrack_removefirst_addtrack, {
          type: "removeTrack",
          payload: 0,
        });
        await answer();

        offer = await peer.request(mediachannel_addtrack_removefirst_addtrack, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        await peer.request(mediachannel_addtrack_removefirst_addtrack, {
          type: "done",
        });
        pc.close();
        done();
      }),
    10 * 1000
  );
});
