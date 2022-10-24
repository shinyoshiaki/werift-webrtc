import { waitVideoPlay, peer, sleep } from "../fixture";

describe("mediachannel_removeTrack", () => {
  const t1 = "mediachannel_removetrack_t1";
  it(
    "If there is one mLine and it is Inactive",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        let offer = await peer.request(t1, {
          type: "init",
        });

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(t1, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const answer = async () => {
          await pc.setRemoteDescription(offer);
          await pc.setLocalDescription(await pc.createAnswer());
          peer
            .request(t1, {
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

        offer = await peer.request(t1, {
          type: "removeTrack",
          payload: 0,
        });
        await answer();

        offer = await peer.request(t1, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        peer.request(t1, {
          type: "done",
        });
        pc.close();
        done();
      }),
    10 * 1000
  );

  const t2 = "mediachannel_removetrack_t2";
  it(
    "If there are two mLines and the first is Inactive",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        let offer = await peer.request(t2, {
          type: "init",
        });

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(t2, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const answer = async () => {
          await pc.setRemoteDescription(offer);
          await pc.setLocalDescription(await pc.createAnswer());
          peer
            .request(t2, {
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

        offer = await peer.request(t2, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        offer = await peer.request(t2, {
          type: "removeTrack",
          payload: 0,
        });
        await answer();

        offer = await peer.request(t2, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track))
        );
        await waitVideoPlay(track);

        peer.request(t2, {
          type: "done",
        });
        pc.close();
        done();
      }),
    10 * 1000
  );
});
