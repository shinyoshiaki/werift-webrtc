import { describe, expect, it } from "vitest";

import {
  OggCallback,
  OggHeaderTypeBos,
  OggHeaderTypeEos,
  OggParser,
  oggCrc32,
  saveOggToFileSystem,
} from "../../src/extra";
import {
  collectOggOutputs,
  createOggInput,
  createOpusFramesAt,
  encodeOggOpusWithFfmpeg,
  isFfmpegOpusAvailable,
  oggOutputsToBuffer,
  oggPagesToPackets,
  parseOggPages,
  probeOggAudio,
} from "../utils";

const range = (count: number, step = 20, start = 0) =>
  [...Array(count).keys()].map((i) => start + i * step);

describe("packages/rtp/tests/processor/ogg.test.ts", () => {
  it("writes OpusHead / OpusTags pages before audio pages", async () => {
    // Arrange
    const frames = createOpusFramesAt(range(100));

    // Act: 2 秒分の 20ms パケットを投入して EOL で終了させる。
    const outputs = await collectOggOutputs((ogg) => {
      for (const frame of frames) {
        ogg.inputAudio({ frame });
      }
      ogg.inputAudio({ eol: true });
    });
    const pages = parseOggPages(oggOutputsToBuffer(outputs));

    // Assert: 1 ページ目は OpusHead のみの BOS、2 ページ目は OpusTags のみ。
    expect(outputs[0].kind).toBe("initial");
    expect(pages[0].headerType).toBe(OggHeaderTypeBos);
    expect(pages[0].granulePosition).toBe(0n);
    expect(pages[0].data.subarray(0, 8).toString()).toBe("OpusHead");
    expect(pages[0].segmentTable).toEqual([19]);
    expect(pages[1].headerType).toBe(0);
    expect(pages[1].granulePosition).toBe(0n);
    expect(pages[1].data.subarray(0, 8).toString()).toBe("OpusTags");
    // Assert: 最終ページだけが EOS で、page sequence は 0 からの連番。
    expect(pages.at(-1)!.headerType).toBe(OggHeaderTypeEos);
    expect(pages.slice(0, -1).every((p) => !(p.headerType & 0x04))).toBe(true);
    expect(pages.map((p) => p.pageSequence)).toEqual(range(pages.length, 1));
    // Assert: 全ページが同一 serial で、checksum が正しい。
    expect(new Set(pages.map((p) => p.serialNumber))).toEqual(
      new Set([0x1234abcd]),
    );
    for (const page of pages) {
      expect(page.checksum).toBe(oggCrc32(page.crcInput));
    }
    // Assert: 音声パケットは 3 ページ目以降に投入順のまま格納される。
    expect(oggPagesToPackets(pages.slice(2))).toEqual(
      frames.map((f) => f.data),
    );
    // Assert: EOL 出力で長さ (ms) が通知される。
    expect(outputs.at(-1)!.eol).toEqual({ duration: 2000 });
  });

  it("keeps granule positions monotonic and ends at the sample count", async () => {
    // Arrange
    const frames = createOpusFramesAt(range(130));

    // Act
    const outputs = await collectOggOutputs(
      (ogg) => {
        for (const frame of frames) {
          ogg.inputAudio({ frame });
        }
        ogg.inputAudio({ eol: true });
      },
      { options: { pageDuration: 500 } },
    );
    const pages = parseOggPages(oggOutputsToBuffer(outputs));
    const granules = pages.slice(2).map((p) => p.granulePosition);

    // Assert: 500ms ごとにページ化され、granule は単調増加する。
    expect(granules).toEqual([
      24_000n,
      48_000n,
      72_000n,
      96_000n,
      120_000n,
      124_800n,
    ]);
    // Assert: 最終 granule は 130 パケット × 960 サンプル (pre-skip 312 は明示指定分が先頭に足される)。
    expect(pages.at(-1)!.granulePosition).toBe(130n * 960n);
  });

  it("fills timestamp gaps so the granule follows the media time", async () => {
    // Arrange: 0-180ms の後、DTX で 1 秒空いて 1200ms から再開する。
    const frames = createOpusFramesAt([...range(10), ...range(10, 20, 1200)]);

    // Act
    const outputs = await collectOggOutputs((ogg) => {
      for (const frame of frames) {
        ogg.inputAudio({ frame });
      }
      ogg.inputAudio({ eol: true });
    });
    const pages = parseOggPages(oggOutputsToBuffer(outputs));
    const packets = oggPagesToPackets(pages.slice(2));

    // Assert: 空白 (200-1200ms) は TOC のみの 1 バイトパケット 50 個で埋められる。
    expect(packets).toHaveLength(70);
    expect(packets.slice(10, 60).every((p) => p.length === 1)).toBe(true);
    expect(packets[10][0] & 0x04).toBe(0x04);
    // Assert: 最終 granule は 1400ms 分 になる。
    expect(pages.at(-1)!.granulePosition).toBe(1400n * 48n);
    expect(outputs.at(-1)!.eol).toEqual({ duration: 1400 });
  });

  it("does not move the granule backwards on reordered timestamps", async () => {
    // Arrange: タイムスタンプが巻き戻るパケットを含める。
    const frames = createOpusFramesAt([0, 20, 40, 10, 60]);

    // Act
    const outputs = await collectOggOutputs(
      (ogg) => {
        for (const frame of frames) {
          ogg.inputAudio({ frame });
        }
        ogg.inputAudio({ eol: true });
      },
      { options: { pageDuration: 20 } },
    );
    const granules = parseOggPages(oggOutputsToBuffer(outputs))
      .slice(2)
      .map((p) => p.granulePosition);

    // Assert: granule は減少せず、パケット長分ずつ進む。
    expect(granules).toEqual([960n, 1920n, 2880n, 3840n, 4800n, 4800n]);
  });

  it("reports output callback failures through onError instead of rejecting", async () => {
    // Arrange: 書き込みに失敗する出力先をつなぐ。
    const ogg = new OggCallback();
    const errors: Error[] = [];
    ogg.onError.subscribe((e) => errors.push(e));
    ogg.pipe(async () => {
      throw new Error("ENOENT");
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    try {
      // Act: フレームと EOL を投入する。
      for (const frame of createOpusFramesAt(range(60))) {
        ogg.inputAudio({ frame });
      }
      ogg.inputAudio({ eol: true });
      await new Promise((r) => setTimeout(r, 50));

      // Assert: エラーは onError に通知され、未処理の Promise 拒否にならない。
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toBe("ENOENT");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("writes an EOS page even without audio", async () => {
    // Act: フレームなしで EOL のみ投入する。
    const outputs = await collectOggOutputs((ogg) => {
      ogg.inputAudio({ eol: true });
    });
    const pages = parseOggPages(oggOutputsToBuffer(outputs));

    // Assert: ヘッダ 2 ページと空の EOS ページだけが出力される。
    expect(pages).toHaveLength(3);
    expect(pages[2].headerType).toBe(OggHeaderTypeEos);
    expect(pages[2].segmentTable).toEqual([]);
  });

  it("is readable by OggParser", async () => {
    // Arrange
    const frames = createOpusFramesAt(range(60), 300);

    // Act
    const outputs = await collectOggOutputs((ogg) => {
      for (const frame of frames) {
        ogg.inputAudio({ frame });
      }
      ogg.inputAudio({ eol: true });
    });
    const parser = new OggParser().read(oggOutputsToBuffer(outputs));

    // Assert: 既存パーサでもページ数と最終 granule が読み戻せる。
    expect(parser.pages.length).toBeGreaterThan(3);
    expect(parser.pages.at(-1)!.granulePosition).toBe(60 * 960);
    expect(parser.pages[0].segments[0].subarray(0, 8).toString()).toBe(
      "OpusHead",
    );
  });

  it("is readable by mediabunny", async () => {
    // Arrange
    const frames = createOpusFramesAt(range(50));
    const outputs = await collectOggOutputs(
      (ogg) => {
        for (const frame of frames) {
          ogg.inputAudio({ frame });
        }
        ogg.inputAudio({ eol: true });
      },
      { track: { channels: 1 } },
    );

    // Act
    const input = createOggInput(oggOutputsToBuffer(outputs));
    try {
      // Assert: 1 つの Opus 音声トラック (mono, 48kHz, 1 秒) として解釈される。
      await expect(input.canRead()).resolves.toBe(true);
      const [audioTrack] = await input.getAudioTracks();
      expect(await audioTrack!.getCodec()).toBe("opus");
      expect(await audioTrack!.getNumberOfChannels()).toBe(1);
      expect(await audioTrack!.getSampleRate()).toBe(48_000);
      expect(await input.computeDuration()).toBeCloseTo(1, 2);
    } finally {
      input.dispose();
    }
  });

  it("saveOggToFileSystem appends pages and reports eol", async () => {
    // Arrange
    const { mkdtemp, readFile, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = await mkdtemp(join(tmpdir(), "werift-ogg-"));
    const path = join(dir, "out.ogg");
    const save = saveOggToFileSystem(path);
    const eols: boolean[] = [];

    try {
      // Act
      const outputs = await collectOggOutputs((ogg) => {
        for (const frame of createOpusFramesAt(range(10))) {
          ogg.inputAudio({ frame });
        }
        ogg.inputAudio({ eol: true });
      });
      for (const output of outputs) {
        eols.push(await save(output));
      }

      // Assert: ファイルは出力の単純連結で、eol 出力でのみ true が返る。
      expect(await readFile(path)).toEqual(oggOutputsToBuffer(outputs));
      expect(eols.at(-1)).toBe(true);
      expect(eols.slice(0, -1).every((e) => !e)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe.skipIf(!isFfmpegOpusAvailable())("decoded with ffmpeg", () => {
    it("remuxes real libopus packets into a decodable file", async () => {
      // Arrange: libopus でエンコードした 2 秒のパケット列を取り出す。
      const source = parseOggPages(encodeOggOpusWithFfmpeg(2));
      const packets = oggPagesToPackets(source).slice(2);

      // Act: 20ms 間隔のタイムスタンプで Ogg に書き直す。
      const outputs = await collectOggOutputs((ogg) => {
        packets.forEach((data, i) => {
          ogg.inputAudio({ frame: { data, isKeyframe: true, time: i * 20 } });
        });
        ogg.inputAudio({ eol: true });
      });
      const result = probeOggAudio(oggOutputsToBuffer(outputs));

      // Assert: ffprobe が Opus stereo 48kHz と認識し、全体をエラーなくデコードできる。
      expect(result.codecName).toBe("opus");
      expect(result.channels).toBe(2);
      expect(result.sampleRate).toBe(48_000);
      expect(result.decodeErrors).toBe("");
      // Assert: ffprobe の長さはパケット数 × 20ms と一致する。
      expect(result.duration).toBeCloseTo((packets.length * 960) / 48_000, 4);
      // Assert: 実際にデコードされたサンプル数が全パケット分と一致し、先頭が欠落しない。
      expect(result.decodedSamples).toBe(packets.length * 960);
    });
  });
});
