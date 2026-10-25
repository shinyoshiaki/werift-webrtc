// MP4Base (fMP4) の映像寸法解決を、ffmpeg (libx264) で生成した実 H.264 ストリームで検証する。
//
// Fixture: tests/data/h264/*.h264 (Annex B, 30fps, 15 frames, IDR every 5 frames
// with in-band SPS/PPS, AUD at every access unit). Regenerate with:
//
//   ./tests/data/h264/generate.sh
//
// which runs, per fixture:
//
//   ffmpeg -f lavfi -i "testsrc2=size=<WxH>:rate=30:duration=0.5" <extra> -an \
//     -c:v libx264 -preset veryfast -tune zerolatency -crf 40 \
//     -g 5 -keyint_min 5 -sc_threshold 0 -bf 0 -x264-params aud=1 \
//     -f h264 <name>.h264
//
//   baseline_200x150     : 200x150  -profile:v baseline -pix_fmt yuv420p
//   high_320x240_sar4_3  : 320x240  -vf setsar=4/3 -profile:v high -pix_fmt yuv420p
//   high_180x320         : 180x320  -profile:v high -pix_fmt yuv420p
//
// ffprobe が使える環境 (CI は ffmpeg を install 済み) では、出力 fMP4 を FFmpeg で
// 全フレームデコードし、寸法 / SAR / DAR / デコード枚数も検証する。

import SPSParser from "../../src/extra/container/mp4/sps-parser";
import {
  type FfprobeVideoResult,
  createAudioFrames,
  createAudioTrack,
  createMp4Input,
  createVideoTrack,
  isFfprobeAvailable,
  loadH264AccessUnits,
  mp4OutputsToBuffer,
  muxMp4Frames,
  probeMp4Video,
  stripH264ParameterSets,
  truncateH264Sps,
} from "../utils";

const fixtures = [
  {
    file: "baseline_200x150.h264",
    codec: "avc1.42c00c",
    width: 200,
    height: 150,
    ffprobe: {
      profile: "Constrained Baseline",
      sampleAspectRatio: "1:1",
      displayAspectRatio: "4:3",
    },
  },
  {
    file: "high_320x240_sar4_3.h264",
    codec: "avc1.64000d",
    width: 320,
    height: 240,
    ffprobe: {
      profile: "High",
      sampleAspectRatio: "4:3",
      displayAspectRatio: "16:9",
    },
  },
  {
    file: "high_180x320.h264",
    codec: "avc1.64000d",
    width: 180,
    height: 320,
    ffprobe: {
      profile: "High",
      sampleAspectRatio: "1:1",
      displayAspectRatio: "9:16",
    },
  },
] as const;

const frameDuration = 1 / 30;

/** 最初の GOP (frame 0-4) を初期化に使えなくした入力。frame 5 の IDR から始まるはず */
const brokenFirstGopCases = [
  {
    name: "the stream joins mid-GOP (starts with delta frames)",
    frames: () => loadH264AccessUnits("baseline_200x150.h264").slice(2),
  },
  {
    name: "the first IDR lacks SPS/PPS",
    frames: () => {
      const frames = loadH264AccessUnits("baseline_200x150.h264");
      return [stripH264ParameterSets(frames[0]), ...frames.slice(1)];
    },
  },
  {
    name: "the first IDR has a truncated SPS",
    frames: () => {
      const frames = loadH264AccessUnits("baseline_200x150.h264");
      return [truncateH264Sps(frames[0], 4), ...frames.slice(1)];
    },
  },
];

describe("packages/rtp/tests/processor/mp4.realData.test.ts", () => {
  describe("read back with mediabunny", () => {
    it.each(fixtures)(
      "resolves $file dimensions from the SPS when the track has none",
      async ({ file, codec, width, height }) => {
        const frames = loadH264AccessUnits(file);

        // Act: 寸法未指定の Track に実ストリーム全フレームを投入し、EOL で finalize する。
        const outputs = await muxMp4Frames([createVideoTrack()], frames);

        const input = createMp4Input(mp4OutputsToBuffer(outputs));
        try {
          // Assert: SPS の crop 適用後サイズと codec string で 15 フレーム全てが書かれていることを確認する。
          const [videoTrack] = await input.getVideoTracks();
          expect(await videoTrack!.getCodecParameterString()).toBe(codec);
          expect(await videoTrack!.getCodedWidth()).toBe(width);
          expect(await videoTrack!.getCodedHeight()).toBe(height);
          expect(await videoTrack!.computePacketStats()).toMatchObject({
            packetCount: frames.length,
          });
          // Assert: EOL は 1 回だけ届くことを確認する。
          expect(outputs.filter((o) => "eol" in o && o.eol)).toHaveLength(1);
        } finally {
          input.dispose();
        }
      },
    );

    it("treats a partially specified track like an unspecified one", async () => {
      const frames = loadH264AccessUnits("baseline_200x150.h264");

      // Act: width だけを指定した Track で mux する。
      const outputs = await muxMp4Frames(
        [createVideoTrack({ width: 640 })],
        frames,
      );

      const input = createMp4Input(mp4OutputsToBuffer(outputs));
      try {
        // Assert: 部分指定は無視され、SPS 由来の 200x150 になることを確認する。
        const [videoTrack] = await input.getVideoTracks();
        expect(await videoTrack!.getDisplayWidth()).toBe(200);
        expect(await videoTrack!.getDisplayHeight()).toBe(150);
      } finally {
        input.dispose();
      }
    });

    it("prefers explicit track dimensions over the SPS", async () => {
      const frames = loadH264AccessUnits("baseline_200x150.h264");

      // Act: SPS (200x150) と異なる 640x360 を明示した Track で mux する。
      const outputs = await muxMp4Frames(
        [createVideoTrack({ width: 640, height: 360 })],
        frames,
      );

      const input = createMp4Input(mp4OutputsToBuffer(outputs));
      try {
        // Assert: 既存挙動どおり明示値が使われることを確認する。
        const [videoTrack] = await input.getVideoTracks();
        expect(await videoTrack!.getDisplayWidth()).toBe(640);
        expect(await videoTrack!.getDisplayHeight()).toBe(360);
      } finally {
        input.dispose();
      }
    });

    it.each(brokenFirstGopCases)(
      "initializes on the next IDR when $name",
      async ({ frames }) => {
        const input = frames();

        // Act: 初期化に使えない先頭 GOP を含むストリームを投入する (例外が出ないことも確認)。
        const outputs = await muxMp4Frames([createVideoTrack()], input);

        const mp4 = createMp4Input(mp4OutputsToBuffer(outputs));
        try {
          // Assert: frame 5 の IDR から 10 フレームだけが書かれ、寸法は SPS 由来であることを確認する。
          const [videoTrack] = await mp4.getVideoTracks();
          expect(await videoTrack!.getDisplayWidth()).toBe(200);
          expect(await videoTrack!.getDisplayHeight()).toBe(150);
          expect(await videoTrack!.computePacketStats()).toMatchObject({
            packetCount: 10,
          });
          expect(await videoTrack!.getFirstTimestamp()).toBeCloseTo(
            5 * frameDuration,
            3,
          );
        } finally {
          mp4.dispose();
        }
      },
    );

    it("emits only a single eol when no IDR carries SPS/PPS", async () => {
      const frames = loadH264AccessUnits("baseline_200x150.h264").map(
        (frame) => (frame.isKeyframe ? stripH264ParameterSets(frame) : frame),
      );

      // Act: 全 IDR から SPS/PPS を除いた実ストリームを投入して EOL で終える。
      const outputs = await muxMp4Frames([createVideoTrack()], frames);

      // Assert: data 出力は 0 件で、EOL だけが 1 回届くことを確認する。
      expect(outputs).toEqual([{ eol: true }]);
    });

    it("falls back to SAR 1:1 when the SPS signals an unspecified SAR (0:0)", async () => {
      // ffmpeg の h264_metadata は SAR 0:0 を書けない (0/0, 1/0 は拒否, 0/1 は idc=1 になる) ため、
      // 実ストリームの parseSPS 結果だけを aspect_ratio_idc=255, sar 0:0 相当に差し替える。
      const parseSPS = SPSParser.parseSPS.bind(SPSParser);
      const spy = vi.spyOn(SPSParser, "parseSPS").mockImplementation((sps) => {
        const details = parseSPS(sps);
        return {
          ...details,
          sar_ratio: { width: 0, height: 0 },
          present_size: {
            width: Number.NaN,
            height: details.codec_size.height,
          },
        };
      });
      try {
        const frames = loadH264AccessUnits("baseline_200x150.h264");

        // Act: SAR 0:0 と解析される実ストリームを寸法未指定で mux する。
        const outputs = await muxMp4Frames([createVideoTrack()], frames);

        const input = createMp4Input(mp4OutputsToBuffer(outputs));
        try {
          // Assert: キーフレームが捨てられ続けることなく、最初の IDR から 1:1 の 200x150 で書かれることを確認する。
          const [videoTrack] = await input.getVideoTracks();
          expect(await videoTrack!.getDisplayWidth()).toBe(200);
          expect(await videoTrack!.getDisplayHeight()).toBe(150);
          expect(await videoTrack!.computePacketStats()).toMatchObject({
            packetCount: frames.length,
          });
        } finally {
          input.dispose();
        }
      } finally {
        spy.mockRestore();
      }
    });

    it("writes audio + video when the video dimensions are omitted", async () => {
      const frames = loadH264AccessUnits("high_320x240_sar4_3.h264");

      // Act: 寸法未指定の実映像と Opus を交互に投入して finalize する。
      const outputs = await muxMp4Frames(
        [createAudioTrack(1), createVideoTrack({}, 2)],
        frames,
        createAudioFrames(),
      );

      const input = createMp4Input(mp4OutputsToBuffer(outputs));
      try {
        // Assert: 2 トラックの MP4 になり、映像は SPS 由来の 320x240 であることを確認する。
        expect(await input.getTracks()).toHaveLength(2);
        const [videoTrack] = await input.getVideoTracks();
        expect(await videoTrack!.getCodedWidth()).toBe(320);
        expect(await videoTrack!.getCodedHeight()).toBe(240);
        // Assert: EOL は 1 回だけ届くことを確認する。
        expect(outputs.filter((o) => "eol" in o && o.eol)).toHaveLength(1);
      } finally {
        input.dispose();
      }
    });
  });

  describe.skipIf(!isFfprobeAvailable())("decoded with ffprobe", () => {
    it.each(fixtures)(
      "decodes every frame of $file with SPS-derived size and aspect",
      async ({ file, width, height, ffprobe }) => {
        const frames = loadH264AccessUnits(file);

        // Act: 寸法未指定で mux し、FFmpeg で全フレームデコードする。
        const outputs = await muxMp4Frames([createVideoTrack()], frames);
        const probe = probeMp4Video(mp4OutputsToBuffer(outputs));

        // Assert: 寸法・profile・SAR/DAR が元ストリームどおりで、全フレームがエラー無くデコードできることを確認する。
        expect(probe).toEqual<FfprobeVideoResult>({
          ...ffprobe,
          width,
          height,
          decodedFrames: frames.length,
          errors: "",
        });
      },
    );

    it.each(brokenFirstGopCases)(
      "decodes the stream from the next IDR when $name",
      async ({ frames }) => {
        // Act: 先頭 GOP が使えないストリームを mux し、FFmpeg でデコードする。
        const outputs = await muxMp4Frames([createVideoTrack()], frames());
        const probe = probeMp4Video(mp4OutputsToBuffer(outputs));

        // Assert: 2 番目の GOP 以降の 10 フレームがエラー無くデコードできることを確認する。
        expect(probe).toMatchObject({
          width: 200,
          height: 150,
          decodedFrames: 10,
          errors: "",
        });
      },
    );
  });
});
