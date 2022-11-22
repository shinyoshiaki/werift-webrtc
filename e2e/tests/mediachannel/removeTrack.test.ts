import { waitVideoPlay, peer, sleep } from "../fixture";

const mediachannel_removetrack_addtrack = "mediachannel_removetrack_addtrack";
const mediachannel_addtrack_removefirst_addtrack =
  "mediachannel_addtrack_removefirst_addtrack";

const mediachannel_offer_replace_second = "mediachannel_offer_replace_second";

describe("mediachannel_removeTrack", () => {
  it(
    mediachannel_removetrack_addtrack,
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
    mediachannel_addtrack_removefirst_addtrack,
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

  it(
    mediachannel_offer_replace_second,
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        await peer.request(mediachannel_offer_replace_second, {
          type: "init",
        });

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(mediachannel_offer_replace_second, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const [video] = (
          await navigator.mediaDevices.getUserMedia({ video: true })
        ).getTracks();

        // add first
        pc.addTransceiver(video, { direction: "sendonly" });
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(mediachannel_offer_replace_second, {
          type: "offer",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);

        await peer.request(mediachannel_offer_replace_second, {
          type: "check",
          payload: { index: 0 },
        });

        // add second
        const second = pc.addTransceiver(video, { direction: "sendonly" });
        {
          await pc.setLocalDescription(await pc.createOffer());
          const answer = await peer.request(mediachannel_offer_replace_second, {
            type: "offer",
            payload: pc.localDescription,
          });
          await pc.setRemoteDescription(answer);
        }
        await peer.request(mediachannel_offer_replace_second, {
          type: "check",
          payload: { index: 1 },
        });

        // add third
        pc.addTransceiver(video, { direction: "sendonly" });
        {
          await pc.setLocalDescription(await pc.createOffer());
          const answer = await peer.request(mediachannel_offer_replace_second, {
            type: "offer",
            payload: pc.localDescription,
          });
          await pc.setRemoteDescription(answer);
        }
        await peer.request(mediachannel_offer_replace_second, {
          type: "check",
          payload: { index: 2 },
        });

        // remove second
        pc.removeTrack(second.sender);
        {
          await pc.setLocalDescription(await pc.createOffer());
          const answer = await peer.request(mediachannel_offer_replace_second, {
            type: "offer",
            payload: pc.localDescription,
          });

          await pc.setRemoteDescription(answer).catch((e) => {
            throw e;
          });
        }

        // replace second
        pc.addTransceiver(video, { direction: "sendonly" });
        {
          await pc.setLocalDescription(await pc.createOffer());
          const answer = await peer.request(mediachannel_offer_replace_second, {
            type: "offer",
            payload: pc.localDescription,
          });
          await pc.setRemoteDescription(answer);
        }
        await peer.request(mediachannel_offer_replace_second, {
          type: "check",
          payload: { index: 1 },
        });

        pc.close();
        done();
      }),
    6000 * 1000
  );
});
