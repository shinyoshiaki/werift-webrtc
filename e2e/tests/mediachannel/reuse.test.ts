import { browserName, peer, sleep } from "../fixture";

// Issue #705: 停止した m-line の port 0 交渉と、同じ index の再利用
const reuseModes = [
  "mediachannel_reuse_compatible",
  "mediachannel_reuse_aggressive",
] as const;
const mediachannel_reject_unsupported_video =
  "mediachannel_reject_unsupported_video";

function mLines(sdp: string) {
  return sdp
    .split(/\r?\n/)
    .reduce<{ port: number; mid?: string }[]>((acc, line) => {
      const m = line.match(/^m=\w+ (\d+) /);
      if (m) {
        acc.push({ port: Number(m[1]) });
      }
      const mid = line.match(/^a=mid:(.+)$/);
      if (mid && acc.length) {
        acc[acc.length - 1].mid = mid[1];
      }
      return acc;
    }, []);
}

describe("mediachannel_reuse", () => {
  if (browserName === "Firefox") {
    return;
  }

  for (const label of reuseModes) {
    it(label, async () => {
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const [camera] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, { type: "candidate", payload: candidate })
          .catch(() => {});
      };

      // werift の offer に答え、送信していない transceiver には camera を載せる
      const answer = async (offer: RTCSessionDescriptionInit) => {
        await pc.setRemoteDescription(offer);
        for (const transceiver of pc.getTransceivers()) {
          if (transceiver.currentDirection === "stopped") continue;
          if (transceiver.direction === "stopped") continue;
          if (!transceiver.sender.track) {
            await transceiver.sender.replaceTrack(camera);
            transceiver.direction = "sendrecv";
          }
        }
        await pc.setLocalDescription(await pc.createAnswer());
        await peer.request(label, {
          type: "answer",
          payload: pc.localDescription,
        });
        return pc.localDescription!.sdp;
      };

      await answer(await peer.request(label, { type: "init" }));
      const first = await peer.request(label, { type: "check", payload: 1 });
      expect(first.received).toBe(true);

      let previousMid = first.mid;
      for (let round = 0; round < 2; round++) {
        // removeTrack + stop の offer は index 1 を port 0 にし、Chromium も停止を確定する
        const stopOffer = await peer.request(label, {
          type: "removeAndStop",
          payload: 1,
        });
        const stopAnswer = await answer(stopOffer);
        expect(mLines(stopOffer.sdp)[1].port).toBe(0);
        expect(mLines(stopAnswer)[1].port).toBe(0);

        // 確定後の追加は m-line 数を増やさず、同じ index に新 MID を置く
        const addOffer = await peer.request(label, { type: "add" });
        const lines = mLines(addOffer.sdp);
        expect(lines).toHaveLength(2);
        expect(lines[1].port).not.toBe(0);
        expect(lines[1].mid).not.toBe(previousMid);
        await answer(addOffer);

        // 再利用した位置で Chromium からの RTP を werift が受信できる
        const check = await peer.request(label, {
          type: "check",
          payload: 1,
        });
        expect(check.received).toBe(true);
        expect(check.mid).toBe(lines[1].mid);
        expect(check.transceivers).toBe(2);
        previousMid = check.mid;
      }

      await peer.request(label, { type: "done" });
      camera.stop();
      pc.close();
    }, 60_000);
  }

  it(mediachannel_reject_unsupported_video, async () => {
    if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
    await sleep(100);
    const label = mediachannel_reject_unsupported_video;

    await peer.request(label, { type: "init" });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pc.onicecandidate = ({ candidate }) => {
      peer
        .request(label, { type: "candidate", payload: candidate })
        .catch(() => {});
    };
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    const [audio, video] = ["audio", "video"].map(
      (kind) =>
        pc.getTransceivers().find((t) => t.sender.track?.kind === kind)!,
    );

    // Chromium の audio + video (BUNDLE) offer に音声専用 werift が答える
    await pc.setLocalDescription(await pc.createOffer());
    // 停止した transceiver の mid は null になるため offer 時点で控える
    const videoMid = video.mid;
    const answer = await peer.request(label, {
      type: "offer",
      payload: pc.localDescription,
    });
    await pc.setRemoteDescription(answer);

    // video は port 0 で拒否され、Chromium 側の transceiver も停止する
    const videoLine = mLines(answer.sdp).find((l) => l.mid === videoMid)!;
    expect(videoLine.port).toBe(0);
    expect(video.currentDirection).toBe("stopped");

    // audio は受け入れられ、werift が RTP を受信する
    const check = await peer.request(label, { type: "check" });
    expect(check.received).toBe(true);
    expect(check.videoRejected).toBe(true);

    // 拒否後の re-offer も成立する
    audio.direction = "sendonly";
    await pc.setLocalDescription(await pc.createOffer());
    const reAnswer = await peer.request(label, {
      type: "offer",
      payload: pc.localDescription,
    });
    await pc.setRemoteDescription(reAnswer);
    expect(mLines(reAnswer.sdp).map((l) => l.port === 0)).toEqual(
      mLines(pc.localDescription!.sdp).map((l) => l.port === 0),
    );

    await peer.request(label, { type: "done" });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    pc.close();
  }, 60_000);
});
