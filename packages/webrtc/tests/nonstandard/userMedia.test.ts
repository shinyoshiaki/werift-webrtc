import { Readable } from "stream";

import {
  type RtpPacket,
  dePacketizeRtpPackets,
  useH264,
  useOPUS,
  useVP8,
} from "../../src";
import { getUserMedia } from "../../src/nonstandard";
import {
  collectFrames,
  createAvMp4Buffer,
  createAvWebmBuffer,
  createH264Frames,
  createOpusFrames,
  createTempMediaFile,
  createVp8Frames,
  waitUntil,
} from "./userMediaTestUtils";

describe("nonstandard/userMedia file playback", () => {
  test("getUserMedia({ buffer, loop: true }) packetizes WebM VP8/Opus and emits sourceChanged on loop", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await getUserMedia({
      buffer: mediaBuffer,
      loop: true,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP8();

    const videoFramesPromise = collectFrames(media.video!, 4);
    const audioFramesPromise = collectFrames(media.audio!, 4);
    const sourceChanges: Array<{ sequenceNumber: number; timestamp: number }> =
      [];
    const { unSubscribe } = media.video!.onSourceChanged.subscribe((header) => {
      sourceChanges.push(header);
    });

    // 実行: buffer source の WebM を loop 再生し、2 周目の先頭 packet まで受け取る。
    const startPromise = media.start();
    await waitUntil(() => sourceChanges.length >= 1);
    const [videoFrames, audioFrames] = await Promise.all([
      videoFramesPromise,
      audioFramesPromise,
    ]);
    media.stop();
    await startPromise;

    // 検証: 1 周目と 2 周目の先頭フレームが元の VP8/Opus サンプルへ復元でき、loop 境界で sourceChanged が発火する。
    expect(sourceChanges).toHaveLength(1);
    expect(sourceChanges[0].sequenceNumber).toBe(
      videoFrames[3][0].header.sequenceNumber,
    );
    expect(sourceChanges[0].timestamp).toBe(videoFrames[3][0].header.timestamp);

    expect(
      dePacketizeRtpPackets("VP8", videoFrames[0]).data.equals(
        createVp8Frames()[0].data,
      ),
    ).toBe(true);
    expect(
      dePacketizeRtpPackets("VP8", videoFrames[3]).data.equals(
        createVp8Frames()[0].data,
      ),
    ).toBe(true);
    expect(audioFrames[0][0].payload.equals(createOpusFrames()[0].data)).toBe(
      true,
    );
    expect(audioFrames[3][0].payload.equals(createOpusFrames()[0].data)).toBe(
      true,
    );
  });

  test("getUserMedia({ path }) packetizes MP4 H264/Opus in-process", async () => {
    const mediaBuffer = await createAvMp4Buffer();
    const tempFile = await createTempMediaFile(mediaBuffer, "mp4");

    try {
      const media = await getUserMedia({
        path: tempFile.path,
      });
      media.audio!.codec = useOPUS();
      media.video!.codec = useH264();
      const videoPackets: RtpPacket[] = [];
      const audioPackets: RtpPacket[] = [];
      media.video!.onReceiveRtp.subscribe((rtp) => {
        videoPackets.push(rtp.clone());
      });
      media.audio!.onReceiveRtp.subscribe((rtp) => {
        audioPackets.push(rtp.clone());
      });

      // 実行: path source の MP4 を再生し、映像 3 フレームと音声 2 packet 分の RTP が揃うまで待つ。
      await media.start();
      await waitUntil(
        () => videoPackets.length >= 5 && audioPackets.length >= 2,
        10_000,
      );
      media.stop();
      const videoFrames = splitFrames(videoPackets);
      const audioFrames = splitFrames(audioPackets);

      // 検証: H264 access unit と Opus packets が元の MP4 サンプル列に対応している。
      expect(videoFrames).toHaveLength(3);
      expect(audioFrames).toHaveLength(2);
      expect(
        dePacketizeRtpPackets("MPEG4/ISO/AVC", videoFrames[0]).data.equals(
          createH264Frames()[0].data,
        ),
      ).toBe(true);
      expect(
        dePacketizeRtpPackets("MPEG4/ISO/AVC", videoFrames[1]).data.equals(
          createH264Frames()[1].data,
        ),
      ).toBe(true);
      expect(audioFrames[0][0].payload.equals(createOpusFrames()[1].data)).toBe(
        true,
      );
      expect(audioFrames[1][0].payload.equals(createOpusFrames()[2].data)).toBe(
        true,
      );
    } finally {
      await tempFile.cleanup();
    }
  }, 15_000);

  test("getUserMedia({ stream }) accepts Readable input", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await getUserMedia({
      stream: Readable.from([mediaBuffer]),
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP8();
    const videoFramesPromise = collectFrames(media.video!, 1);
    const audioFramesPromise = collectFrames(media.audio!, 1);

    // 実行: Readable stream source から WebM を再生して、最初の audio/video packet を取り出す。
    await media.start();
    const [videoFrames, audioFrames] = await Promise.all([
      videoFramesPromise,
      audioFramesPromise,
    ]);

    // 検証: stream 入力でも VP8/Opus の RTP が生成される。
    expect(
      dePacketizeRtpPackets("VP8", videoFrames[0]).data.equals(
        createVp8Frames()[0].data,
      ),
    ).toBe(true);
    expect(audioFrames[0][0].payload.equals(createOpusFrames()[0].data)).toBe(
      true,
    );
  });

  test("throws when negotiated codec does not match the source codec", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await getUserMedia({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useH264();

    // 実行: VP8 source に対して H264 を negotiated codec に設定して start する。
    const startPromise = media.start();

    // 検証: codec 不一致を明示するエラーで start が失敗する。
    await expect(startPromise).rejects.toThrow(
      "Input video codec video/vp8 does not match negotiated codec video/h264",
    );
  });
});

function splitFrames(packets: RtpPacket[]) {
  const frames: RtpPacket[][] = [];
  let currentFrame: RtpPacket[] = [];

  for (const packet of packets) {
    currentFrame.push(packet);
    if (packet.header.marker) {
      frames.push(currentFrame);
      currentFrame = [];
    }
  }

  return frames;
}
