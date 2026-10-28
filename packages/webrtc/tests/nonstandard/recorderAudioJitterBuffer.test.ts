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

/** Arrange: 欠番 (seq 3) が後続パケットの後に再送で届く音声を録音する */
async function recordLateRetransmission(jitterBuffer?: {
  latency: number;
}): Promise<Buffer> {
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

  // Act: 到着順は 1, 2, 4, 5, 3
  for (const seq of [1, 2, 4, 5, 3]) {
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
});
