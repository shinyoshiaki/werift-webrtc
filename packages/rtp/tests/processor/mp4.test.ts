import type { Track } from "../../src/extra";
import { computeRatio } from "../../src/extra/processor/mp4";
import {
  collectMp4Buffer,
  collectMp4Outputs,
  createAudioFrames,
  createAudioTrack,
  createAvcKeyframeWithTruncatedSps,
  createAvcKeyframeWithoutParameterSets,
  createFrame,
  createMp4Input,
  createVideoFrames,
  createVideoTrack,
  mp4OutputsToBuffer,
} from "../utils";

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

  it("emits a single eol after stop", async () => {
    const tracks: Track[] = [
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
    ];

    const outputs = await collectMp4Outputs(
      tracks,
      async (mp4) => {
        // Act: 遅延するコールバック配下で音声フレームを投入し、EOL 入力で stop 経路を通す。
        for (const frame of createAudioFrames()) {
          mp4.inputAudio({ frame });
        }
        mp4.inputAudio({ eol: true });
      },
      { callbackDelay: 10 },
    );

    // Assert: 初期化セグメントに加えてメディア断片が届き、終端通知は 1 回だけであることを確認する。
    expect(
      outputs.filter((output) => "eol" in output && output.eol),
    ).toHaveLength(1);
    expect(outputs.at(-1)).toEqual({ eol: true });
    expect(
      outputs.filter((output) => "data" in output && output.type === "init"),
    ).toHaveLength(1);
    expect(
      outputs.filter((output) => "data" in output && output.type !== "init"),
    ).not.toHaveLength(0);
  });

  it("flushes final fragments before destroy resolves", async () => {
    const tracks: Track[] = [
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
    ];

    const outputs = await collectMp4Outputs(
      tracks,
      async (mp4) => {
        // Act: EOL を送らずに destroy を呼び、destroy 経路だけで finalize させる。
        for (const frame of createAudioFrames()) {
          mp4.inputAudio({ frame });
        }
        mp4.destroy();
      },
      { callbackDelay: 10 },
    );

    // Assert: destroy 後も初期化セグメントだけで終わらず、最終メディア断片と単一 EOL が届くことを確認する。
    expect(
      outputs.filter((output) => "eol" in output && output.eol),
    ).toHaveLength(1);
    expect(outputs.at(-1)).toEqual({ eol: true });
    expect(
      outputs.filter((output) => "data" in output && output.type === "init"),
    ).toHaveLength(1);
    expect(
      outputs.filter((output) => "data" in output && output.type !== "init"),
    ).not.toHaveLength(0);
  });

  it("normalizes negative audio timestamps before finalize", async () => {
    const tracks: Track[] = [
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
    ];

    const outputs = await collectMp4Outputs(tracks, async (mp4) => {
      // Act: 負の開始時刻を含む Opus フレームを投入し、finalize する。
      for (const frame of [
        createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x01]), true, -200),
        createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x02]), true, -180),
        createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x03]), true, -160),
      ]) {
        mp4.inputAudio({ frame });
      }
      mp4.inputAudio({ eol: true });
    });

    // Assert: 負 timestamp でも例外なくメディア断片と EOL が届く。
    expect(
      outputs.filter((output) => "eol" in output && output.eol),
    ).toHaveLength(1);
    expect(
      outputs.filter((output) => "data" in output && output.type !== "init"),
    ).not.toHaveLength(0);
  });

  it("stop with negative timestamps does not leak unhandled rejection", async () => {
    const tracks: Track[] = [
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
    ];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const outputs = await collectMp4Outputs(
        tracks,
        async (mp4) => {
          // Act: 負 timestamp のあと destroy し、finalize 完了を待つ。
          mp4.inputAudio({
            frame: createFrame(
              Buffer.from([0xf8, 0xff, 0xfe, 0x01]),
              true,
              -200,
            ),
          });
          mp4.inputAudio({
            frame: createFrame(
              Buffer.from([0xf8, 0xff, 0xfe, 0x02]),
              true,
              -180,
            ),
          });
          mp4.destroy();
        },
        { callbackDelay: 10 },
      );

      await new Promise<void>((resolve) => setImmediate(resolve));

      // Assert: EOL が届き、未処理 rejection は残らない。
      expect(
        outputs.filter((output) => "eol" in output && output.eol),
      ).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  describe("video dimensions fallback", () => {
    it.each([
      { name: "width / height omitted", dimensions: {} },
      { name: "only width given", dimensions: { width: 640 } },
      { name: "zero dimensions", dimensions: { width: 0, height: 0 } },
      {
        name: "NaN dimensions",
        dimensions: { width: Number.NaN, height: Number.NaN },
      },
      { name: "negative dimensions", dimensions: { width: -640, height: 360 } },
      {
        name: "infinite dimensions",
        dimensions: { width: Number.POSITIVE_INFINITY, height: 360 },
      },
      {
        name: "non integer dimensions",
        dimensions: { width: 640.5, height: 360 },
      },
    ])("falls back to SPS dimensions when $name", async ({ dimensions }) => {
      const tracks = [createVideoTrack(dimensions)];

      const buffer = await collectMp4Buffer(tracks, async (mp4) => {
        // Act: 寸法が無効な Track に SPS 付きキーフレームと delta を投入し、EOL で finalize する。
        for (const frame of createVideoFrames()) {
          mp4.inputVideo({ frame });
        }
        mp4.inputVideo({ eol: true });
      });

      const input = createMp4Input(buffer);
      try {
        // Assert: ハングせずに完了し、SPS 由来の 1920x1080 で読み戻せることを確認する。
        await expect(input.canRead()).resolves.toBe(true);
        const [videoTrack] = await input.getVideoTracks();
        expect(videoTrack).toBeDefined();
        expect(await videoTrack!.getCodecParameterString()).toBe("avc1.42001e");
        expect(await videoTrack!.getDisplayWidth()).toBe(1920);
        expect(await videoTrack!.getDisplayHeight()).toBe(1080);
      } finally {
        input.dispose();
      }
    });

    it("writes an av mp4 when video dimensions are omitted", async () => {
      const tracks = [createAudioTrack(1), createVideoTrack({}, 2)];

      const outputs = await collectMp4Outputs(tracks, async (mp4) => {
        // Act: 寸法未指定の映像と音声を交互に投入し、両方の EOL で finalize する。
        const audioFrames = createAudioFrames();
        const videoFrames = createVideoFrames();
        for (let i = 0; i < 3; i++) {
          mp4.inputAudio({ frame: audioFrames[i] });
          mp4.inputVideo({ frame: videoFrames[i] });
        }
        mp4.inputAudio({ eol: true });
        mp4.inputVideo({ eol: true });
      });

      // Assert: init / media segment が出力され、EOL はちょうど 1 回であることを確認する。
      expect(
        outputs.filter((output) => "data" in output && output.type === "init"),
      ).toHaveLength(1);
      expect(
        outputs.filter((output) => "data" in output && output.type !== "init"),
      ).not.toHaveLength(0);
      expect(
        outputs.filter((output) => "eol" in output && output.eol),
      ).toHaveLength(1);

      // Assert: 読み戻した映像トラックの寸法が SPS 由来であることを確認する。
      const input = createMp4Input(mp4OutputsToBuffer(outputs));
      try {
        const [videoTrack] = await input.getVideoTracks();
        expect(await input.getTracks()).toHaveLength(2);
        expect(await videoTrack!.getDisplayWidth()).toBe(1920);
        expect(await videoTrack!.getDisplayHeight()).toBe(1080);
      } finally {
        input.dispose();
      }
    });

    it("skips keyframes without SPS/PPS and initializes on the next valid keyframe", async () => {
      const tracks = [createVideoTrack()];

      const buffer = await collectMp4Buffer(tracks, async (mp4) => {
        // Act: SPS/PPS 無しキーフレーム → delta → 正常なキーフレーム列の順に投入する。
        //      最初の 2 フレームの投入で例外が出ないことも確認する。
        expect(() =>
          mp4.inputVideo({ frame: createAvcKeyframeWithoutParameterSets(0) }),
        ).not.toThrow();
        expect(() =>
          mp4.inputVideo({
            frame: createFrame(
              Buffer.from("00000001419a0011", "hex"),
              false,
              33,
            ),
          }),
        ).not.toThrow();
        for (const frame of createVideoFrames(1000)) {
          mp4.inputVideo({ frame });
        }
        mp4.inputVideo({ eol: true });
      });

      const input = createMp4Input(buffer);
      try {
        // Assert: 2 枚目のキーフレームで初期化され、寸法は SPS 由来になっていることを確認する。
        const [videoTrack] = await input.getVideoTracks();
        expect(videoTrack).toBeDefined();
        expect(await videoTrack!.getDisplayWidth()).toBe(1920);
        expect(await videoTrack!.getDisplayHeight()).toBe(1080);

        // Assert: 捨てたフレームは含まれず、2 枚目のキーフレーム (1000ms) から 3 サンプルが始まることを確認する。
        expect(await videoTrack!.computePacketStats()).toMatchObject({
          packetCount: 3,
        });
        expect(await videoTrack!.getFirstTimestamp()).toBeCloseTo(1, 3);
        expect(await input.computeDuration()).toBeCloseTo(1.099, 3);
      } finally {
        input.dispose();
      }
    });

    it.each([
      {
        name: "without SPS/PPS",
        frame: createAvcKeyframeWithoutParameterSets(0),
      },
      {
        name: "with truncated SPS",
        frame: createAvcKeyframeWithTruncatedSps(0),
      },
    ])(
      "emits only a single eol when the only keyframe is $name",
      async ({ frame }) => {
        const tracks = [createVideoTrack()];

        const outputs = await collectMp4Outputs(tracks, async (mp4) => {
          // Act: 寸法を解決できないキーフレームだけを投入し、EOL で終了させる。
          expect(() => mp4.inputVideo({ frame })).not.toThrow();
          mp4.inputVideo({ eol: true });
        });

        // Assert: data 出力は無く、EOL がちょうど 1 回だけ届くことを確認する。
        expect(outputs).toEqual([{ eol: true }]);
      },
    );

    it("emits only a single eol on destroy before the video track is initialized", async () => {
      const tracks = [createVideoTrack()];
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const outputs = await collectMp4Outputs(
          tracks,
          async (mp4) => {
            // Act: 解決不能なキーフレームだけを投入して destroy する。
            mp4.inputVideo({ frame: createAvcKeyframeWithoutParameterSets(0) });
            mp4.destroy();
          },
          { callbackDelay: 10 },
        );

        await new Promise<void>((resolve) => setImmediate(resolve));

        // Assert: data 出力は無く EOL が 1 回だけ届き、未処理 rejection も残らないことを確認する。
        expect(outputs).toEqual([{ eol: true }]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("computeRatio", () => {
    it.each([
      [undefined, 1080],
      [1920, undefined],
      [0, 0],
      [0, 1080],
      [Number.NaN, 1080],
      [Number.POSITIVE_INFINITY, 1080],
      [-1920, 1080],
      [1920.5, 1080],
    ])("returns undefined for %s:%s", (a, b) => {
      // Act / Assert: 不正値ではループに入らず即座に undefined を返すことを確認する。
      expect(computeRatio(a, b)).toBeUndefined();
    });

    it("reduces valid dimensions to the lowest terms", () => {
      // Act / Assert: 正の整数は最大公約数で約分されることを確認する。
      expect(computeRatio(1920, 1080)).toEqual([16, 9]);
      expect(computeRatio(640, 360)).toEqual([16, 9]);
      expect(computeRatio(1440, 1080)).toEqual([4, 3]);
    });
  });
});
