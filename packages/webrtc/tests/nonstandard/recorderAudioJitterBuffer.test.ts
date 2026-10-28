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
});
