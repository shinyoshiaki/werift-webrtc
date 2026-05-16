import { setTimeout as wait } from "timers/promises";

import type { RtpPacket } from "../../src/imports/rtp";
import type { MediaStreamTrack } from "../../src/media/track";
import { Navigator } from "../../src/nonstandard";

describe("nonstandard/navigator dummy media", () => {
  test("getUserMedia({ audio: true }) emits deterministic dummy opus RTP", async () => {
    const navigator = new Navigator({
      dummyMedia: {
        enabled: true,
      },
    });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const [track] = stream.getAudioTracks();

    // 実行: dummy audio track から連続する RTP を受け取る。
    const packets = await waitForPackets(track, 3);

    // 検証: audio track が 1 本返り、sequence / timestamp が Opus 想定で進む。
    expect(stream.getTracks()).toHaveLength(1);
    expect(
      packets[1].header.sequenceNumber - packets[0].header.sequenceNumber,
    ).toBe(1);
    expect(
      packets[2].header.sequenceNumber - packets[1].header.sequenceNumber,
    ).toBe(1);
    expect(packets[1].header.timestamp - packets[0].header.timestamp).toBe(960);
    expect(packets[2].header.timestamp - packets[1].header.timestamp).toBe(960);

    // 実行: track を止めて timer 駆動の送出を止める。
    track.stop();
    navigator.mediaDevices.cleanup();
  });

  test("getUserMedia({ video: true }) emits deterministic dummy vp8 RTP and stops cleanly", async () => {
    const navigator = new Navigator({
      dummyMedia: {
        enabled: true,
      },
    });
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const [track] = stream.getVideoTracks();
    const packets: RtpPacket[] = [];
    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      packets.push(rtp.clone());
    });

    // 実行: keyframe 周期をまたぐまで dummy video RTP を収集する。
    await waitUntil(() => packets.length >= 31);

    // 検証: sequence / timestamp / marker が連続し、先頭と 31 枚目が keyframe payload になる。
    expect(stream.getTracks()).toHaveLength(1);
    for (let index = 1; index < packets.length; index++) {
      expect(
        packets[index].header.sequenceNumber -
          packets[index - 1].header.sequenceNumber,
      ).toBe(1);
      expect(
        packets[index].header.timestamp - packets[index - 1].header.timestamp,
      ).toBe(3000);
      expect(packets[index].header.marker).toBe(true);
    }
    expect(Buffer.compare(packets[0].payload, packets[1].payload)).not.toBe(0);
    expect(Buffer.compare(packets[0].payload, packets[30].payload)).toBe(0);

    // 実行: stop 後に追加 packet が届かないことを確認する。
    const packetCountBeforeStop = packets.length;
    track.stop();
    await wait(80);

    // 検証: stop 後は open handle を残さず送出が止まる。
    expect(packets).toHaveLength(packetCountBeforeStop);
    unSubscribe();
    navigator.mediaDevices.cleanup();
  });
});

function waitForPackets(track: MediaStreamTrack, count: number) {
  return new Promise<RtpPacket[]>((resolve) => {
    const packets: RtpPacket[] = [];
    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      packets.push(rtp.clone());
      if (packets.length >= count) {
        unSubscribe();
        resolve(packets);
      }
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const startedAt = performance.now();

  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Condition timed out");
    }
    await wait(10);
  }
}
