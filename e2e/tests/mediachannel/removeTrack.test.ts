import { browserName, peer, sleep, waitVideoPlay } from "../fixture";

// Issue #705: werift の mLineReuse ("compatible" 既定 / "aggressive") のどちらでも
// removeTrack の挙動が変わらないことを確認する
// replacedMLineIndex: removeTrack で inactive にした m-line の後に追加した transceiver の m-line index
//   compatible: inactive は port 9 のまま残るので、Chromium は末尾 (3) に追加する
//   aggressive: inactive は従来どおり port 0 で拒否されるので、Chromium は同じ位置 (1) を再利用する
const modes = [
  { mode: "compatible", suffix: "", removedPort: 9, replacedMLineIndex: 3 },
  {
    mode: "aggressive",
    suffix: "_aggressive",
    removedPort: 0,
    replacedMLineIndex: 1,
  },
] as const;

/** SDP 内で指定 MID を持つ m-line の index と port を返す */
function findMLine(sdp: string, mid: string | null) {
  const sections = sdp.split(/\r?\n(?=m=)/).slice(1);
  const index = sections.findIndex((section) =>
    section.split(/\r?\n/).includes(`a=mid:${mid}`),
  );
  const port = Number(sections[index]?.match(/^m=\w+ (\d+) /)?.[1]);
  return { index, port };
}

describe.each(modes)(
  "mediachannel_removeTrack ($mode)",
  ({ suffix, removedPort, replacedMLineIndex }) => {
    const mediachannel_removetrack_addtrack = `mediachannel_removetrack_addtrack${suffix}`;
    const mediachannel_addtrack_removefirst_addtrack = `mediachannel_addtrack_removefirst_addtrack${suffix}`;
    const mediachannel_offer_replace_second = `mediachannel_offer_replace_second${suffix}`;

    if (browserName !== "Firefox") {
      it(mediachannel_removetrack_addtrack, async () =>
        new Promise<void>(async (done) => {
          if (!peer.connected)
            await new Promise<void>((r) => peer.on("open", r));
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
          if (!peer.connected)
            await new Promise<void>((r) => peer.on("open", r));
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

          offer = await peer.request(
            mediachannel_addtrack_removefirst_addtrack,
            {
              type: "addTrack",
            },
          );
          answer();
          track = await new Promise<MediaStreamTrack>(
            (r) => (pc.ontrack = (e) => r(e.track)),
          );
          await waitVideoPlay(track);

          offer = await peer.request(
            mediachannel_addtrack_removefirst_addtrack,
            {
              type: "removeTrack",
              payload: 0,
            },
          );
          await answer();

          offer = await peer.request(
            mediachannel_addtrack_removefirst_addtrack,
            {
              type: "addTrack",
            },
          );
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
      // 失敗時に hang せず fail するよう、Promise executor で包まない
      async () => {
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
        // aggressive では Chromium が停止を確定すると mid が null になるため先に保持する
        const secondMid = second.mid;
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

          // removeTrack した m-line の answer port はモードごとの従来挙動になる
          expect(findMLine(answer.sdp, secondMid).port).toBe(removedPort);
        }

        // replace second
        const replaced = pc.addTransceiver(video, { direction: "sendonly" });
        {
          await pc.setLocalDescription(await pc.createOffer());
          const answer = await peer.request(mediachannel_offer_replace_second, {
            type: "offer",
            payload: pc.localDescription,
          });
          await pc.setRemoteDescription(answer);
        }
        // 追加した transceiver の m-line 位置はモードごとに決まり、そこで RTP を受信できる
        const replacedIndex = findMLine(
          pc.localDescription!.sdp,
          replaced.mid,
        ).index;
        expect(replacedIndex).toBe(replacedMLineIndex);
        await peer.request(mediachannel_offer_replace_second, {
          type: "check",
          payload: { index: replacedIndex },
        });

        pc.close();
      },
      60 * 1000,
    );
  },
);
