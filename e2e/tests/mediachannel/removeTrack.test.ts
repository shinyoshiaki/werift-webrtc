import { browserName, peer, sleep, waitVideoPlay } from "../fixture";
import { createReuseBrowserPair, mediaSections } from "./removeTrack.helpers";

const mediachannel_removetrack_addtrack = "mediachannel_removetrack_addtrack";
const mediachannel_addtrack_removefirst_addtrack =
  "mediachannel_addtrack_removefirst_addtrack";

const mediachannel_offer_replace_second = "mediachannel_offer_replace_second";

function expectInactiveSection(sdp: string, mid: string, count: number) {
  const [session, ...media] = sdp.split(/(?=^m=)/m);
  expect(media).toHaveLength(count);
  expect(media[1]).toContain(`a=mid:${mid}\r\n`);
  expect(media[1]).toContain("a=inactive\r\n");
  expect(Number(media[1].split(" ")[1])).toBeGreaterThan(0);
  const bundle = session.match(/^a=group:BUNDLE (.+)\r?$/m)?.[1];
  expect(bundle?.trim().split(/\s+/)).toContain(mid);
}

describe("mediachannel_removeTrack", () => {
  for (const scenario of [
    "compatible",
    "aggressive",
    "browser-stop",
    "werift-stop",
  ] as const) {
    it(`m-line reuse: ${scenario}`, async () => {
      const { pc, track, second, negotiate, request, close } =
        await createReuseBrowserPair(
          scenario === "aggressive" ? "aggressive" : "compatible",
        );
      const oldMid = second.mid;
      try {
        // Act: removeTrack と stop をまとめるか、removeTrack のみをモード別に交渉する。
        if (scenario === "werift-stop") {
          const offer = await request("stop", { index: 1 });
          await pc.setRemoteDescription(offer);
          await pc.setLocalDescription(await pc.createAnswer());
          await request("answer", pc.localDescription);
        } else {
          pc.removeTrack(second.sender);
          if (scenario === "browser-stop") second.stop();
          await negotiate();
        }
        // Assert: 互換モードの removeTrack 単独のみ非ゼロ port を維持する。
        const port = mediaSections(pc.remoteDescription!.sdp)[1].port;
        if (scenario === "compatible") expect(port).toBeGreaterThan(0);
        else expect(port).toBe(0);
        // Act: 新規 transceiver を追加し、再交渉する。
        const next = pc.addTransceiver(track, { direction: "sendonly" });
        await negotiate();
        // Assert: stop 済み／積極モードは2本、inactive を維持する場合は3本になる。
        const sections = mediaSections(pc.localDescription!.sdp);
        expect(sections).toHaveLength(scenario === "compatible" ? 3 : 2);
        expect(next.mid).not.toBe(oldMid);
        const index = sections.findIndex((section) => section.mid === next.mid);
        expect(index).toBe(scenario === "compatible" ? 2 : 1);
        // Assert: 再利用した MID/index で werift が RTP を実際に受信する。
        await request("check", { index });
      } finally {
        await close();
      }
    }, 60_000);
  }

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
  it(mediachannel_offer_replace_second, async () => {
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

      // Act: 1 本目を交渉し、werift 側で RTP 受信を確認する。
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

      // Act: 2 本目を追加し、対応する m-line で RTP 受信を確認する。
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

      // Act: 3 本目を追加し、対応する m-line で RTP 受信を確認する。
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

      const secondMid = second.mid!;
      // Act: sendonly の 2 本目を removeTrack し、inactive として再交渉する。
      pc.removeTrack(second.sender);
      expect(second.direction).toBe("inactive");
      {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(mediachannel_offer_replace_second, {
          type: "offer",
          payload: pc.localDescription,
        });

        await pc.setRemoteDescription(answer);
        // Assert: inactive は reject ではなく、同じ MID・非ゼロ port・BUNDLE 所属を維持する。
        expectInactiveSection(pc.localDescription!.sdp, secondMid, 3);
        expectInactiveSection(answer.sdp, secondMid, 3);
        expect(second.currentDirection).toBe("inactive");
      }

      // Act: ブラウザの addTransceiver は新規 transceiver を作る（W3C WebRTC §5.1）。
      // inactive は停止・reject ではないため、既存の 2 本目の m-line は再利用されない。
      const fourth = pc.addTransceiver(video, { direction: "sendonly" });
      {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(mediachannel_offer_replace_second, {
          type: "offer",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
        // Assert: 2 本目を維持したまま、4 本目の m-line が追加・受諾される。
        expectInactiveSection(pc.localDescription!.sdp, secondMid, 4);
        expectInactiveSection(answer.sdp, secondMid, 4);
        expect(pc.getTransceivers()).toHaveLength(4);
        expect(fourth).not.toBe(second);
        expect(fourth.mid).not.toBe(secondMid);
        expect(fourth.currentDirection).toBe("sendonly");
        expect(answer.sdp.split(/(?=^m=)/m)[4]).toContain(
          `a=mid:${fourth.mid}\r\n`,
        );
      }
      // Assert: 新規 m-line（index=3）へ実際に RTP が届く。
      await peer.request(mediachannel_offer_replace_second, {
        type: "check",
        payload: { index: 3 },
      });
    } finally {
      pc.close();
    }
  }, 60_000);
});
