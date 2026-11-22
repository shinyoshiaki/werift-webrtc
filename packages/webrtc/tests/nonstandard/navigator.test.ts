import { setTimeout as wait } from "timers/promises";

import { type RtpPacket, Vp8RtpPayload } from "../../src/imports/rtp";
import { MediaStreamTrack } from "../../src/media/track";
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
    // 初期 sequence は乱数なので 16 bit の差で比べる
    expect(sequenceDelta(packets[0], packets[1])).toBe(1);
    expect(sequenceDelta(packets[1], packets[2])).toBe(1);
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

    // 検証: sequence / timestamp / marker が連続し、先頭と 31 枚目が同じ keyframe 本体になる。
    expect(stream.getTracks()).toHaveLength(1);
    for (let index = 1; index < packets.length; index++) {
      expect(sequenceDelta(packets[index - 1], packets[index])).toBe(1);
      expect(
        packets[index].header.timestamp - packets[index - 1].header.timestamp,
      ).toBe(3000);
      expect(packets[index].header.marker).toBe(true);
    }
    const vp8 = packets.map((packet) =>
      Vp8RtpPayload.deSerialize(packet.payload),
    );
    expect(Buffer.compare(vp8[0].payload, vp8[1].payload)).not.toBe(0);
    expect(Buffer.compare(vp8[0].payload, vp8[30].payload)).toBe(0);
    expect(vp8[0].isKeyframe).toBe(true);
    expect(vp8[1].isKeyframe).toBe(false);
    expect(vp8[30].isKeyframe).toBe(true);

    // 検証: 全 packet がブラウザ同等の X/I/M descriptor (L/T/K なし) を持ち、PictureID が 1 frame ごとに +1 される。
    for (const [index, payload] of vp8.entries()) {
      expect([...packets[index].payload.subarray(0, 2)]).toEqual([0x90, 0x80]);
      expect(payload.mBit).toBe(1);
      expect(payload.lBit).toBe(0);
      expect(payload.tBit).toBe(0);
      expect(payload.kBit).toBe(0);
      if (index > 0) {
        expect(payload.pictureId).toBe(
          ((vp8[index - 1].pictureId ?? 0) + 1) & 0x7fff,
        );
      }
    }

    // 実行: stop 後に追加 packet が届かないことを確認する。
    const packetCountBeforeStop = packets.length;
    track.stop();
    await wait(80);

    // 検証: stop 後は open handle を残さず送出が止まる。
    expect(packets).toHaveLength(packetCountBeforeStop);
    unSubscribe();
    navigator.mediaDevices.cleanup();
  });

  test("別々の MediaDevices の dummy track は SSRC と sequence が重ならない", async () => {
    // Arrange: dummy media を持つ Navigator を 2 つ用意する
    const navigators = [0, 1].map(
      () => new Navigator({ dummyMedia: { enabled: true } }),
    );

    // Act: それぞれから audio と video の track を取り、最初の RTP を受け取る
    const firsts: RtpPacket[] = [];
    const tracks: MediaStreamTrack[] = [];
    for (const navigator of navigators) {
      for (const kind of ["audio", "video"] as const) {
        const stream = await navigator.mediaDevices.getUserMedia({
          [kind]: true,
        });
        const [track] = stream.getTracks();
        tracks.push(track);
        const [first] = await waitForPackets(track, 1);
        firsts.push(first);
      }
    }

    // Assert: 4 つの source の SSRC がすべて異なり、同じ PeerConnection で送っても区別できる
    expect(new Set(firsts.map((p) => p.header.ssrc)).size).toBe(4);
    expect(
      new Set(firsts.map((p) => `${p.header.ssrc}/${p.header.sequenceNumber}`))
        .size,
    ).toBe(4);

    for (const track of tracks) track.stop();
    for (const navigator of navigators) navigator.mediaDevices.cleanup();
  });

  test("cloned getUserMedia track forwards extensions and receive info", async () => {
    // Arrange: 既存ソースを clone する Navigator
    const source = new MediaStreamTrack({ kind: "audio" });
    const navigator = new Navigator({ audio: source });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const [cloned] = stream.getAudioTracks();
    const rtp = {
      clone() {
        return this;
      },
      header: { sequenceNumber: 1, timestamp: 0 },
      payload: Buffer.alloc(0),
    } as unknown as RtpPacket;
    let forwarded: { extensions?: unknown; info?: unknown } | undefined;
    cloned.onReceiveRtp.subscribe((_packet, extensions, info) => {
      forwarded = { extensions, info };
    });

    // Act: ソースへ padding 付きで配送する
    source.onReceiveRtp.execute(rtp, { mid: "0" }, { type: "padding" });

    // Assert: 第 2・3 引数を落とさず、padding では unmute しない
    expect(forwarded).toEqual({
      extensions: { mid: "0" },
      info: { type: "padding" },
    });
    expect(cloned.muted).toBe(true);

    cloned.stop();
    navigator.mediaDevices.cleanup();
  });
});

/** `next` の sequence が `prev` から何進んだか (16 bit で折り返す)。 */
function sequenceDelta(prev: RtpPacket, next: RtpPacket) {
  return (next.header.sequenceNumber - prev.header.sequenceNumber) & 0xffff;
}

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
