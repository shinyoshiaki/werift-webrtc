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
  // Do not wrap in `new Promise(async (done) => ...)`; an awaited rejection
  // inside that pattern leaves the outer Promise unsettled and hangs until
  // testTimeout (previously 6000s), which exceeded the CI wall clock.
  it(mediachannel_offer_replace_second, async () => {
    // Arrange: シグナリング接続と sendonly video トラックを用意する。
    if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
    await sleep(100);

    await peer.request(mediachannel_offer_replace_second, {
      type: "init",
    });

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    try {
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

      // Act: first / second / third を追加し、remove→replace 後も RTP が届くこと。
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

      pc.removeTrack(second.sender);
      {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(mediachannel_offer_replace_second, {
          type: "offer",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }

      pc.addTransceiver(video, { direction: "sendonly" });
      {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(mediachannel_offer_replace_second, {
          type: "offer",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }
      // Assert: replace 後の m-line でも RTP を受信できる。
      await peer.request(mediachannel_offer_replace_second, {
        type: "check",
        payload: { index: 1 },
      });
    } finally {
      pc.close();
    }
  }, 60_000);
});
