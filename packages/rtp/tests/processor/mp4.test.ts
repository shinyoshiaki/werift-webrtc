import type { Track } from "../../src/extra";
import { collectMp4Buffer, createMp4Input } from "../utils";

describe("packages/rtp/tests/processor/mp4.test.ts", () => {
  it("writes an opus-only mp4", async () => {
    const tracks: Track[] = [
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
    ];

    const buffer = await collectMp4Buffer(tracks, async (mp4) => {
      // Act: Opus パケットを時系列順に投入し、最後に EOL で finalize させる。
      for (const frame of createAudioFrames()) {
        mp4.inputAudio({ frame });
      }
      mp4.inputAudio({ eol: true });
    });

    const input = createMp4Input(buffer);
    try {
      // Assert: 読み戻した MP4 が 1 つの Opus 音声トラックとして解釈できることを確認する。
      await expect(input.canRead()).resolves.toBe(true);

      const [audioTrack] = await input.getAudioTracks();
      expect(audioTrack).toBeDefined();
      expect(await input.getTracks()).toHaveLength(1);
      expect(await audioTrack!.getCodec()).toBe("opus");
      expect(await audioTrack!.getCodecParameterString()).toBe("opus");
      expect(await audioTrack!.getNumberOfChannels()).toBe(2);
      expect(await audioTrack!.getSampleRate()).toBe(48_000);
      expect(await input.computeDuration()).toBeCloseTo(0.06, 3);
    } finally {
      input.dispose();
    }
  });

  it("writes an avc-only mp4", async () => {
    const tracks: Track[] = [
      {
        width: 640,
        height: 360,
        kind: "video",
        codec: "avc1",
        clockRate: 90_000,
        trackNumber: 1,
      },
    ];

    const buffer = await collectMp4Buffer(tracks, async (mp4) => {
      // Act: SPS/PPS を含むキーフレームから始めて H.264 フレーム列を投入し、最後に finalize させる。
      for (const frame of createVideoFrames()) {
        mp4.inputVideo({ frame });
      }
      mp4.inputVideo({ eol: true });
    });

    const input = createMp4Input(buffer);
    try {
      // Assert: 読み戻した MP4 が 1 つの H.264 映像トラックとして解釈できることを確認する。
      await expect(input.canRead()).resolves.toBe(true);

      const [videoTrack] = await input.getVideoTracks();
      expect(videoTrack).toBeDefined();
      expect(await input.getTracks()).toHaveLength(1);
      expect(await videoTrack!.getCodec()).toBe("avc");
      expect(await videoTrack!.getCodecParameterString()).toBe("avc1.42001e");
      expect(await videoTrack!.getDisplayWidth()).toBe(640);
      expect(await videoTrack!.getDisplayHeight()).toBe(360);
      expect(await input.computeDuration()).toBeCloseTo(0.099, 3);
    } finally {
      input.dispose();
    }
  });

  it("writes an av mp4", async () => {
    const tracks: Track[] = [
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
      {
        width: 640,
        height: 360,
        kind: "video",
        codec: "avc1",
        clockRate: 90_000,
        trackNumber: 2,
      },
    ];

    const buffer = await collectMp4Buffer(tracks, async (mp4) => {
      // Act: 音声と映像を交互に投入して、複数トラックの MP4 を組み立てる。
      const audioFrames = createAudioFrames();
      const videoFrames = createVideoFrames();

      mp4.inputAudio({ frame: audioFrames[0] });
      mp4.inputVideo({ frame: videoFrames[0] });
      mp4.inputAudio({ frame: audioFrames[1] });
      mp4.inputVideo({ frame: videoFrames[1] });
      mp4.inputAudio({ frame: audioFrames[2] });
      mp4.inputVideo({ frame: videoFrames[2] });

      mp4.inputAudio({ eol: true });
      mp4.inputVideo({ eol: true });
    });

    const input = createMp4Input(buffer);
    try {
      // Assert: 読み戻した MP4 が audio + video の 2 トラックを持ち、双方のメタデータが保持されることを確認する。
      await expect(input.canRead()).resolves.toBe(true);

      const [audioTrack] = await input.getAudioTracks();
      const [videoTrack] = await input.getVideoTracks();
      expect(audioTrack).toBeDefined();
      expect(videoTrack).toBeDefined();
      expect(await input.getTracks()).toHaveLength(2);
      expect(await audioTrack!.getCodec()).toBe("opus");
      expect(await videoTrack!.getCodec()).toBe("avc");
      expect(await videoTrack!.getDisplayWidth()).toBe(640);
      expect(await videoTrack!.getDisplayHeight()).toBe(360);
      expect(await audioTrack!.getSampleRate()).toBe(48_000);
      expect(await audioTrack!.getNumberOfChannels()).toBe(2);
      expect(await input.computeDuration()).toBeCloseTo(0.099, 3);
    } finally {
      input.dispose();
    }
  });
});

function createAudioFrames() {
  return [
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x01]), true, 0),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x02]), true, 20),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x03]), true, 40),
  ];
}

function createVideoFrames() {
  return [
    createFrame(
      Buffer.from(
        "000000016742001eda01e0089f970110000003000100000300320f1831960000000168ce06e20000000165888421a0",
        "hex",
      ),
      true,
      0,
    ),
    createFrame(Buffer.from("00000001419a2211", "hex"), false, 33),
    createFrame(Buffer.from("00000001419a3344", "hex"), false, 66),
  ];
}

function createFrame(data: Buffer, isKeyframe: boolean, time: number) {
  return { data, isKeyframe, time };
}
