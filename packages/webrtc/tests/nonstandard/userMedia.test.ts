import { Readable } from "stream";

import {
  type RtpPacket,
  dePacketizeRtpPackets,
  useAV1X,
  useH264,
  useOPUS,
  useVP8,
  useVP9,
} from "../../src";
import { createFileMediaPlayer } from "../../src/nonstandard/userMedia";
import * as packetizerModule from "../../src/nonstandard/userMedia/packetizer";
import {
  collectFrames,
  createAv1Frames,
  createAv1OpusWebmBuffer,
  createAvMp4Buffer,
  createAvWebmBuffer,
  createH264Frames,
  createOpusFrames,
  createTempMediaFile,
  createVp8Frames,
  createVp9Frames,
  createVp9OpusWebmBuffer,
  waitUntil,
} from "./userMediaTestUtils";

describe("nonstandard/userMedia file playback", () => {
  test("createFileMediaPlayer({ buffer, loop: true }) packetizes WebM VP8/Opus and emits sourceChanged on loop", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
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
    await waitUntil(() => !(media as any).session);

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

  test("createFileMediaPlayer({ path }) packetizes MP4 H264/Opus in-process", async () => {
    const mediaBuffer = await createAvMp4Buffer();
    const tempFile = await createTempMediaFile(mediaBuffer, "mp4");

    try {
      const media = await createFileMediaPlayer({
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

  test("createFileMediaPlayer({ stream }) accepts Readable input", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
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

  test("createFileMediaPlayer({ stream }) can start again after natural EOF", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
      stream: Readable.from([mediaBuffer]),
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP8();

    // 実行: stream 入力を最後まで再生し、自然終了後に同じ source を再 start する。
    const firstVideoFramesPromise = collectFrames(media.video!, 1);
    const firstAudioFramesPromise = collectFrames(media.audio!, 1);
    await media.start();
    const [firstVideoFrames, firstAudioFrames] = await Promise.all([
      firstVideoFramesPromise,
      firstAudioFramesPromise,
    ]);
    await waitUntil(() => !(media as any).session);

    const secondVideoFramesPromise = collectFrames(media.video!, 1);
    const secondAudioFramesPromise = collectFrames(media.audio!, 1);
    await media.start();
    const [secondVideoFrames, secondAudioFrames] = await Promise.all([
      secondVideoFramesPromise,
      secondAudioFramesPromise,
    ]);
    media.stop();

    // 検証: stream でも初回読込バッファを再利用して、再 start 後に同じ VP8/Opus フレームを送出できる。
    expect(
      dePacketizeRtpPackets("VP8", firstVideoFrames[0]).data.equals(
        createVp8Frames()[0].data,
      ),
    ).toBe(true);
    expect(
      dePacketizeRtpPackets("VP8", secondVideoFrames[0]).data.equals(
        createVp8Frames()[0].data,
      ),
    ).toBe(true);
    expect(
      firstAudioFrames[0][0].payload.equals(createOpusFrames()[0].data),
    ).toBe(true);
    expect(
      secondAudioFrames[0][0].payload.equals(createOpusFrames()[0].data),
    ).toBe(true);
  });

  test("createFileMediaPlayer({ buffer }) packetizes WebM VP9/Opus in-process", async () => {
    const mediaBuffer = await createVp9OpusWebmBuffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP9();
    const videoFramesPromise = collectFrames(media.video!, 1);
    const audioFramesPromise = collectFrames(media.audio!, 1);

    // 実行: VP9/Opus の WebM を再生して先頭の audio/video frame を受け取る。
    await media.start();
    const [videoFrames, audioFrames] = await Promise.all([
      videoFramesPromise,
      audioFramesPromise,
    ]);
    media.stop();

    // 検証: VP9/Opus source がコンテナから読まれ、RTP 往復後も元フレームを保つ。
    expect(
      dePacketizeRtpPackets("VP9", videoFrames[0]).data.equals(
        createVp9Frames()[0].data,
      ),
    ).toBe(true);
    expect(audioFrames[0][0].payload.equals(createOpusFrames()[0].data)).toBe(
      true,
    );
  });

  test("createFileMediaPlayer({ buffer }) packetizes WebM AV1/Opus in-process", async () => {
    const mediaBuffer = await createAv1OpusWebmBuffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useAV1X();
    const videoFramesPromise = collectFrames(media.video!, 1);
    const audioFramesPromise = collectFrames(media.audio!, 1);

    // 実行: AV1/Opus の WebM を再生して先頭の audio/video frame を受け取る。
    await media.start();
    const [videoFrames, audioFrames] = await Promise.all([
      videoFramesPromise,
      audioFramesPromise,
    ]);
    media.stop();

    // 検証: AV1/Opus source がコンテナから読まれ、RTP 往復後も元フレームを保つ。
    expect(
      dePacketizeRtpPackets("AV1", videoFrames[0]).data.equals(
        createAv1Frames()[0].data,
      ),
    ).toBe(true);
    expect(audioFrames[0][0].payload.equals(createOpusFrames()[0].data)).toBe(
      true,
    );
  });

  test("throws when negotiated codec does not match the source codec", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
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

  test("throws when legacy width/height options are provided", async () => {
    const mediaBuffer = await createAvWebmBuffer();

    // 実行: 旧 API の width/height を file playback に渡して source を作成する。
    const mediaPromise = createFileMediaPlayer({
      buffer: mediaBuffer,
      width: 640,
      height: 360,
    } as any);

    // 検証: width/height は無視されず、移行案内付きの明示エラーになる。
    await expect(mediaPromise).rejects.toThrow(
      "File playback no longer accepts { width, height }",
    );
  });

  test("throws when negotiated H264 packetization-mode does not match the source", async () => {
    const mediaBuffer = await createAvMp4Buffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useH264({
      parameters:
        "profile-level-id=42e01f;packetization-mode=0;level-asymmetry-allowed=1",
    });

    // 実行: packetization-mode=0 の H264 codec で MP4 source を開始する。
    const startPromise = media.start();

    // 検証: packetization-mode 不一致を明示するエラーで start が失敗する。
    await expect(startPromise).rejects.toThrow(
      "Input video packetization-mode 1 does not match negotiated packetization-mode 0",
    );
  });

  test("throws when negotiated H264 profile-level-id does not match the source", async () => {
    const mediaBuffer = await createAvMp4Buffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useH264({
      parameters:
        "profile-level-id=640c1f;packetization-mode=1;level-asymmetry-allowed=1",
    });

    // 実行: profile-level-id が異なる H264 codec で MP4 source を開始する。
    const startPromise = media.start();

    // 検証: profile-level-id 不一致を明示するエラーで start が失敗する。
    await expect(startPromise).rejects.toThrow(
      "Input video profile-level-id 42e01f does not match negotiated profile-level-id 640c1f",
    );
  });

  test("throws when negotiated Opus channels do not match the source", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS({ channels: 1 });
    media.video!.codec = useVP8();

    // 実行: stereo Opus source に対して mono negotiated codec で start する。
    const startPromise = media.start();

    // 検証: channels 不一致を明示するエラーで start が失敗する。
    await expect(startPromise).rejects.toThrow(
      "Input audio channels 2 do not match negotiated channels 1",
    );
  });

  test("can start again after natural EOF when loop is disabled", async () => {
    const mediaBuffer = await createAvMp4Buffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useH264();

    // 実行: 非 loop の MP4 source を最後まで再生し、自然終了後に同じ source を再度開始する。
    media.start();
    const [firstVideoFrames, firstAudioFrames] = await Promise.all([
      collectFrames(media.video!, 3),
      collectFrames(media.audio!, 2),
    ]);
    await waitUntil(() => !(media as any).session);
    const sourceChanges: Array<{ sequenceNumber: number; timestamp: number }> =
      [];
    media.video!.onSourceChanged.subscribe((header) => {
      sourceChanges.push(header);
    });
    const secondVideoFramesPromise = collectFrames(media.video!, 3);
    const secondAudioFramesPromise = collectFrames(media.audio!, 2);
    await media.start();
    const [secondVideoFrames, secondAudioFrames] = await Promise.all([
      secondVideoFramesPromise,
      secondAudioFramesPromise,
    ]);
    media.stop();

    // 検証: EOF 後の再 start でも、先頭 RTP 送出前に sourceChanged が発火し、同じ H264/Opus サンプル列を再送できる。
    expect(sourceChanges).toHaveLength(1);
    expect(sourceChanges[0].sequenceNumber).toBe(
      secondVideoFrames[0][0].header.sequenceNumber,
    );
    expect(sourceChanges[0].timestamp).toBe(
      secondVideoFrames[0][0].header.timestamp,
    );
    expect(
      dePacketizeRtpPackets("MPEG4/ISO/AVC", firstVideoFrames[0]).data.equals(
        createH264Frames()[0].data,
      ),
    ).toBe(true);
    expect(
      dePacketizeRtpPackets("MPEG4/ISO/AVC", secondVideoFrames[0]).data.equals(
        createH264Frames()[0].data,
      ),
    ).toBe(true);
    expect(
      firstAudioFrames[0][0].payload.equals(createOpusFrames()[1].data),
    ).toBe(true);
    expect(
      secondAudioFrames[0][0].payload.equals(createOpusFrames()[1].data),
    ).toBe(true);
  });

  test("stop is terminal and releases the playback session", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
      loop: true,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP8();

    // 実行: loop 再生を開始して最初のフレーム受信後に stop し、その後の再 start を試みる。
    const firstVideoFramesPromise = collectFrames(media.video!, 1);
    await media.start();
    await firstVideoFramesPromise;
    media.stop();
    await waitUntil(() => !(media as any).session && !(media as any).running);

    // 検証: stop 後は session が解放され、再 start は終端エラーになる。
    await expect(media.start()).rejects.toThrow(
      "The media source has already been stopped",
    );
  });

  test("emits runtime playback errors through onError and releases the session", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP8();

    const originalCreatePacketizer = packetizerModule.createPacketizer;
    const createPacketizerSpy = vi.spyOn(packetizerModule, "createPacketizer");
    createPacketizerSpy.mockImplementation((props) => {
      const packetizer = originalCreatePacketizer(props);
      let packetizeCount = 0;

      return {
        packetize(packet, rtpTimestamp) {
          packetizeCount += 1;
          if (packetizeCount >= 2) {
            throw new Error("synthetic packetize failure");
          }
          return packetizer.packetize(packet, rtpTimestamp);
        },
      };
    });

    try {
      const errorPromise = media.onError.asPromise(3_000);

      // 実行: start 完了後の 2 回目 packetize で失敗させ、利用側の onError 購読へ通知させる。
      await media.start();
      const [error] = await errorPromise;

      // 検証: 実行時エラーが onError へ届き、失敗後の session は解放される。
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("synthetic packetize failure");
      await waitUntil(() => !(media as any).session && !(media as any).running);
    } finally {
      createPacketizerSpy.mockRestore();
      media.stop();
    }
  });

  test("does not emit errors when start and stop are called back-to-back", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    const media = await createFileMediaPlayer({
      buffer: mediaBuffer,
    });

    media.audio!.codec = useOPUS();
    media.video!.codec = useVP8();
    const errors: Error[] = [];
    media.onError.subscribe((error) => {
      errors.push(error);
    });

    // 実行: start 直後に stop を呼んで、初期化途中とのレースを発生させる。
    const startPromise = media.start();
    media.stop();
    await expect(startPromise).resolves.toBeUndefined();
    await waitUntil(() => !(media as any).running && !(media as any).session);

    // 検証: 近接呼び出しでも例外や onError は発生しない。
    expect(errors).toHaveLength(0);
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
