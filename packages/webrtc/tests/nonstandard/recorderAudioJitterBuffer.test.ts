import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { RTCRtpCodecParameters } from "../../src";
import { MediaStreamTrack } from "../../src/media/track";
import { MediaRecorder } from "../../src/nonstandard/recorder";

const marker = (seq: number) =>
  Buffer.from(`PKT${String(seq).padStart(5, "0")}`);

/** Arrange: 欠番が後続パケットの後に再送で届く音声を録音する (既定は seq 3 が最後に届く) */
async function recordLateRetransmission(
  jitterBuffer?: { latency: number; startSequenceNumber?: number },
  arrival = [1, 2, 4, 5, 3],
): Promise<Buffer> {
  const track = new MediaStreamTrack({
    kind: "audio",
    remote: true,
    codec: new RTCRtpCodecParameters({
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      payloadType: 111,
    }),
  });
  const dir = await mkdtemp(join(tmpdir(), "werift-recorder-"));
  const path = join(dir, "audio.webm");
  const recorder = new MediaRecorder({
    tracks: [track],
    path,
    disableNtp: true,
    disableLipSync: true,
    jitterBuffer,
  });
  await new Promise((r) => setTimeout(r, 50));

  // Act: arrival の順に届く
  for (const seq of arrival) {
    track.onReceiveRtp.execute(
      new RtpPacket(
        new RtpHeader({
          payloadType: 111,
          sequenceNumber: seq,
          timestamp: seq * 960,
          ssrc: 1,
        }),
        marker(seq),
      ),
    );
  }
  await recorder.stop();
  return readFile(path);
}

const orderOf = (webm: Buffer) =>
  [1, 2, 3, 4, 5]
    .map((seq) => ({ seq, at: webm.indexOf(marker(seq)) }))
    .filter((p) => p.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((p) => p.seq);

describe("MediaRecorder audio jitterBuffer", () => {
  test("jitterBuffer を指定すると、遅れて届いた再送を元の順序で録音する", async () => {
    // Act
    const webm = await recordLateRetransmission({ latency: 5000 });

    // Assert: 全パケットが seq 順に書かれる
    expect(orderOf(webm)).toEqual([1, 2, 3, 4, 5]);
  });

  test("jitterBuffer を指定しない場合は従来どおり到着順で録音する", async () => {
    // Act
    const webm = await recordLateRetransmission();

    // Assert: 到着順 (seq 3 が最後)
    expect(orderOf(webm)).toEqual([1, 2, 4, 5, 3]);
  });

  test("jitterBuffer に startSequenceNumber を指定すると、後から回収した先頭も元の順序で録音する", async () => {
    // Act: 先頭の 1, 2 が落ち、3〜5 の後に再送で届く
    const webm = await recordLateRetransmission(
      { latency: 5000, startSequenceNumber: 1 },
      [3, 4, 5, 1, 2],
    );

    // Assert: 先頭を含む全パケットが seq 順に書かれる
    expect(orderOf(webm)).toEqual([1, 2, 3, 4, 5]);
  });

  test("startSequenceNumber がなければ、最初に受信した seq より前の先頭は録音されない", async () => {
    // Act
    const webm = await recordLateRetransmission(
      { latency: 5000 },
      [3, 4, 5, 1, 2],
    );

    // Assert: 最初に届いた 3 が先頭扱いになり、1, 2 は失われる
    expect(orderOf(webm)).toEqual([3, 4, 5]);
  });

  /**
   * Arrange / Act: 映像と音声を `order` の順に登録して約 4 秒録音する。
   * 音声は seq 2 が欠落し、jitter buffer (latency 5000ms) が後続を保持したまま録音を止める
   */
  async function recordAv(
    order: ("video" | "audio")[],
    options: {
      jitterBuffer?: { latency: number };
      /** audio frames (20ms) */
      frames?: number;
      /** audio seq not delivered */
      lost?: number[];
      /** video stops after this many ms */
      videoUntilMs?: number;
    } = { jitterBuffer: { latency: 5000 } },
  ) {
    const frames = options.frames ?? 200;
    const lost = options.lost ?? [2];
    const videoUntilMs = options.videoUntilMs ?? Number.POSITIVE_INFINITY;
    const audio = new MediaStreamTrack({
      kind: "audio",
      remote: true,
      codec: new RTCRtpCodecParameters({
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        payloadType: 111,
      }),
    });
    const video = new MediaStreamTrack({
      kind: "video",
      remote: true,
      codec: new RTCRtpCodecParameters({
        mimeType: "video/VP8",
        clockRate: 90000,
        payloadType: 96,
      }),
    });
    const path = join(
      await mkdtemp(join(tmpdir(), "werift-recorder-")),
      "av.webm",
    );
    const recorder = new MediaRecorder({
      tracks: order.map((kind) => (kind === "audio" ? audio : video)),
      path,
      width: 320,
      height: 240,
      disableNtp: true,
      jitterBuffer: options.jitterBuffer,
    });
    await new Promise((r) => setTimeout(r, 50));

    // 4 秒分: 音声 20ms (200 フレーム、seq 2 は届かない)、映像 40ms ごとのキーフレーム
    for (let i = 0; i < frames; i++) {
      if (!lost.includes(i)) {
        audio.onReceiveRtp.execute(
          new RtpPacket(
            new RtpHeader({
              payloadType: 111,
              sequenceNumber: i,
              timestamp: i * 960,
              ssrc: 1,
            }),
            marker(i),
          ),
        );
      }
      if (i % 2 === 0 && i * 20 <= videoUntilMs) {
        video.onReceiveRtp.execute(
          new RtpPacket(
            new RtpHeader({
              payloadType: 96,
              sequenceNumber: i / 2,
              timestamp: i * 1800,
              ssrc: 2,
              marker: true,
            }),
            // VP8: S=1 の記述子とキーフレーム (P=0) の先頭
            Buffer.from([
              0x10, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00,
            ]),
          ),
        );
      }
    }
    await recorder.stop();
    const webm = await readFile(path);
    return Array.from({ length: frames }, (_, i) => i).filter(
      (seq) => webm.indexOf(marker(seq)) >= 0,
    );
  }

  test.each([
    [["video", "audio"] as ("video" | "audio")[]],
    [["audio", "video"] as ("video" | "audio")[]],
  ])(
    "映像と音声 (%j の順に登録) を録音すると、jitter buffer が終了時に排出した音声も捨てない",
    async (order) => {
      // Act
      const saved = await recordAv(order);

      // Assert: 欠落した seq 2 以外の音声 199 フレームが全て保存される
      expect(saved).toEqual(
        Array.from({ length: 200 }, (_, i) => i).filter((i) => i !== 2),
      );
    },
  );

  test("jitterBuffer なしで映像が止まっても、続く 6 秒の音声を全て保存する", async () => {
    // Act: 映像は 240ms で止まり、欠落のない音声 301 フレームが続く
    const saved = await recordAv(["video", "audio"], {
      frames: 301,
      lost: [],
      videoUntilMs: 240,
    });

    // Assert
    expect(saved).toEqual(Array.from({ length: 301 }, (_, i) => i));
  });
});
