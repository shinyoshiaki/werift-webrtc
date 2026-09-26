import { browserName, peer, sleep, waitVideoPlay } from "../fixture";

const mediachannel_removetrack_addtrack = "mediachannel_removetrack_addtrack";
const mediachannel_addtrack_removefirst_addtrack =
  "mediachannel_addtrack_removefirst_addtrack";

const mediachannel_offer_replace_second = "mediachannel_offer_replace_second";

describe("mediachannel_removeTrack", () => {
  if (browserName !== "Firefox") {
    it(mediachannel_removetrack_addtrack, async () =>
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
          (r) => (pc.ontrack = (e) => r(e.track)),
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
          (r) => (pc.ontrack = (e) => r(e.track)),
        );
        await waitVideoPlay(track);

        await peer.request(mediachannel_removetrack_addtrack, {
          type: "done",
        });
        pc.close();
        done();
      }));
  }

  if (browserName != "Firefox") {
    it(mediachannel_addtrack_removefirst_addtrack, async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        let offer = await peer.request(
          mediachannel_addtrack_removefirst_addtrack,
          {
            type: "init",
          },
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
          (r) => (pc.ontrack = (e) => r(e.track)),
        );
        await waitVideoPlay(track);

        offer = await peer.request(mediachannel_addtrack_removefirst_addtrack, {
          type: "addTrack",
        });
        answer();
        track = await new Promise<MediaStreamTrack>(
          (r) => (pc.ontrack = (e) => r(e.track)),
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
          (r) => (pc.ontrack = (e) => r(e.track)),
        );
        await waitVideoPlay(track);

        await peer.request(mediachannel_addtrack_removefirst_addtrack, {
          type: "done",
        });
        pc.close();
        done();
      }));
  }
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
        // removeTrack だけの inactive m-line は再利用されないため、Chromium は新しい m-line を末尾に追加する
        const replaced = pc.addTransceiver(video, { direction: "sendonly" });
        {
          await pc.setLocalDescription(await pc.createOffer());
          const answer = await peer.request(mediachannel_offer_replace_second, {
            type: "offer",
            payload: pc.localDescription,
          });
          await pc.setRemoteDescription(answer);
        }
        const replacedIndex = pc
          .getTransceivers()
          .findIndex((t) => t === replaced);
        expect(replacedIndex).toBe(3);
        await peer.request(mediachannel_offer_replace_second, {
          type: "check",
          payload: { index: replacedIndex },
        });

        pc.close();
        done();
      }),
    6000 * 1000,
  );
});
