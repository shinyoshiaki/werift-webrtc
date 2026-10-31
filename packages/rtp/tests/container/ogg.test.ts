import { describe, expect, test } from "vitest";

import {
  createOggPage,
  createOpusHead,
  createOpusTags,
  getOpusPacketSamples,
  OggHeaderTypeBos,
  OggHeaderTypeContinued,
  OggHeaderTypeEos,
  OggNoGranulePosition,
  OggPager,
  oggCrc32,
  oggLacingValues,
} from "../../src/extra/container/ogg";
import {
  encodeOggOpusWithFfmpeg,
  isFfmpegOpusAvailable,
  oggPagesToPackets,
  parseOggPages,
} from "../utils";

describe("packages/rtp/tests/container/ogg.test.ts", () => {
  describe("oggCrc32", () => {
    test("matches the non-reflected CRC32 check value", () => {
      // Act: 標準チェック文字列の CRC を計算する。
      const crc = oggCrc32(Buffer.from("123456789", "ascii"));

      // Assert: poly 0x04c11db7 / 非反転 / init 0 / xorout 0 の値
      // (CRC-32/POSIX の check 0x765e7680 の最終 XOR を外した値) になる。
      expect(crc).toBe((0x765e7680 ^ 0xffffffff) >>> 0);
      expect(crc).toBe(0x89a1897f);
    });

    test.skipIf(!isFfmpegOpusAvailable())(
      "matches the checksum of pages written by ffmpeg",
      () => {
        // Arrange
        const pages = parseOggPages(encodeOggOpusWithFfmpeg(0.5));

        // Act: checksum フィールドを 0 にしたページで CRC を再計算する。
        const crcs = pages.map((page) => oggCrc32(page.crcInput));

        // Assert: 外部実装 (libogg) が書いた checksum と全ページで一致する。
        expect(crcs).toEqual(pages.map((page) => page.checksum));
      },
    );
  });

  describe("oggLacingValues", () => {
    test.each([
      [0, [0]],
      [1, [1]],
      [254, [254]],
      [255, [255, 0]],
      [256, [255, 1]],
      [510, [255, 255, 0]],
      [511, [255, 255, 1]],
    ])("%i bytes", (length, expected) => {
      // Act / Assert: 255 の倍数のパケットは 0 長セグメントで終端される。
      expect(oggLacingValues(length)).toEqual(expected);
    });
  });

  describe("createOggPage", () => {
    test("writes every header field", () => {
      // Arrange
      const data = Buffer.from([1, 2, 3, 4, 5]);

      // Act
      const page = createOggPage({
        headerType: OggHeaderTypeBos | OggHeaderTypeEos,
        granulePosition: 0x0102030405n,
        serialNumber: 0xdeadbeef,
        pageSequence: 7,
        segmentTable: [2, 3],
        data,
      });
      const [parsed] = parseOggPages(page);

      // Assert: 27 バイトのヘッダ + segment table + データの順で各フィールドが書かれる。
      expect(page.subarray(0, 4).toString("ascii")).toBe("OggS");
      expect(page.readUInt8(4)).toBe(0);
      expect(page.length).toBe(27 + 2 + 5);
      expect(parsed.headerType).toBe(0x06);
      expect(parsed.granulePosition).toBe(0x0102030405n);
      expect(parsed.serialNumber).toBe(0xdeadbeef);
      expect(parsed.pageSequence).toBe(7);
      expect(parsed.segmentTable).toEqual([2, 3]);
      expect(parsed.data).toEqual(data);
      // Assert: checksum は 0 埋めしたページ全体の Ogg CRC と一致する。
      expect(parsed.checksum).toBe(oggCrc32(parsed.crcInput));
    });

    test("writes -1 granule position", () => {
      // Act
      const page = createOggPage({
        headerType: 0,
        granulePosition: OggNoGranulePosition,
        serialNumber: 1,
        pageSequence: 0,
        segmentTable: [],
        data: Buffer.alloc(0),
      });

      // Assert: パケットが完結しないページの granule は全ビット 1 になる。
      expect(page.subarray(6, 14)).toEqual(Buffer.alloc(8, 0xff));
    });

    test("rejects a mismatched segment table", () => {
      // Act / Assert: segment table とデータ長が一致しない場合はエラーになる。
      expect(() =>
        createOggPage({
          headerType: 0,
          granulePosition: 0n,
          serialNumber: 1,
          pageSequence: 0,
          segmentTable: [3],
          data: Buffer.alloc(2),
        }),
      ).toThrow();
    });
  });

  describe("OggPager", () => {
    test.each([254, 255, 256, 510])(
      "round trips a %i byte packet",
      (length) => {
        // Arrange
        const pager = new OggPager(1);
        const packet = Buffer.alloc(length, 0xab);

        // Act
        const pages = [
          ...pager.addPacket(packet, 960n),
          ...pager.flush({ eos: true }),
        ];
        const parsed = parseOggPages(Buffer.concat(pages));

        // Assert: lacing を辿ると元のパケットが 1 つだけ復元され、BOS/EOS が立つ。
        expect(parsed).toHaveLength(1);
        expect(parsed[0].segmentTable).toEqual(oggLacingValues(length));
        expect(parsed[0].headerType).toBe(OggHeaderTypeBos | OggHeaderTypeEos);
        expect(parsed[0].granulePosition).toBe(960n);
        expect(oggPagesToPackets(parsed)).toEqual([packet]);
      },
    );

    test("splits a packet over the 255 segment limit with the continued flag", () => {
      // Arrange
      const pager = new OggPager(1);
      const first = Buffer.alloc(10, 1);
      const large = Buffer.alloc(255 * 300, 2);

      // Act
      const pages = [
        ...pager.addPacket(first, 100n),
        ...pager.addPacket(large, 200n),
        ...pager.flush({ eos: true }),
      ];
      const parsed = parseOggPages(Buffer.concat(pages));

      // Assert: 1 ページ目は 255 セグメントで満杯になり、完結した first の granule を持つ。
      expect(parsed).toHaveLength(2);
      expect(parsed[0].segmentTable).toHaveLength(255);
      expect(parsed[0].headerType).toBe(OggHeaderTypeBos);
      expect(parsed[0].granulePosition).toBe(100n);
      // Assert: 2 ページ目は継続フラグ付きで、large の終端と EOS を含む。
      expect(parsed[1].headerType).toBe(
        OggHeaderTypeContinued | OggHeaderTypeEos,
      );
      expect(parsed[1].granulePosition).toBe(200n);
      expect(parsed.map((p) => p.pageSequence)).toEqual([0, 1]);
      expect(oggPagesToPackets(parsed)).toEqual([first, large]);
    });

    test("uses -1 granule on a page where no packet ends", () => {
      // Arrange
      const pager = new OggPager(1);
      const large = Buffer.alloc(255 * 600, 3);

      // Act
      const pages = [...pager.addPacket(large, 500n), ...pager.flush()];
      const parsed = parseOggPages(Buffer.concat(pages));

      // Assert: 途中ページは granule -1、パケットが終わるページで granule が設定される。
      expect(parsed.map((p) => p.granulePosition)).toEqual([
        OggNoGranulePosition,
        OggNoGranulePosition,
        500n,
      ]);
      expect(parsed.map((p) => p.headerType)).toEqual([
        OggHeaderTypeBos,
        OggHeaderTypeContinued,
        OggHeaderTypeContinued,
      ]);
      expect(oggPagesToPackets(parsed)).toEqual([large]);
    });

    test("does not mark a page continued when a packet starts on it", () => {
      // Arrange
      const pager = new OggPager(1);

      // Act: 1 セグメントのパケットを 256 個入れ、ページ境界をパケット境界に一致させる。
      const pages: Buffer[] = [];
      for (let i = 0; i < 256; i++) {
        pages.push(...pager.addPacket(Buffer.from([i & 0xff]), BigInt(i)));
      }
      pages.push(...pager.flush());
      const parsed = parseOggPages(Buffer.concat(pages));

      // Assert: 2 ページ目は新しいパケットから始まるので継続フラグを持たない。
      expect(parsed.map((p) => p.headerType)).toEqual([OggHeaderTypeBos, 0]);
      expect(parsed.map((p) => p.granulePosition)).toEqual([254n, 255n]);
    });

    test("writes an empty EOS page when nothing is pending", () => {
      // Arrange
      const pager = new OggPager(1);
      pager.addPacket(Buffer.from([1]), 960n);
      pager.flush();

      // Act
      const parsed = parseOggPages(Buffer.concat(pager.flush({ eos: true })));

      // Assert: セグメント 0 個の EOS ページが直前の granule で出力される。
      expect(parsed).toHaveLength(1);
      expect(parsed[0].headerType).toBe(OggHeaderTypeEos);
      expect(parsed[0].segmentTable).toEqual([]);
      expect(parsed[0].granulePosition).toBe(960n);
      // Assert: EOS 後はページを出力しない。
      expect(pager.flush({ eos: true })).toEqual([]);
    });
  });

  describe("Opus headers", () => {
    test("OpusHead", () => {
      // Act
      const head = createOpusHead({ channels: 1, preSkip: 312 });

      // Assert: RFC 7845 §5.1 のレイアウト (mapping family 0) で書かれる。
      expect(head).toEqual(
        Buffer.concat([
          Buffer.from("OpusHead"),
          Buffer.from([1, 1, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0, 0, 0]),
        ]),
      );
    });

    test("OpusHead rejects more than 2 channels", () => {
      // Act / Assert: mapping family 0 で表せないチャンネル数はエラーになる。
      expect(() => createOpusHead({ channels: 6 })).toThrow();
    });

    test("OpusTags", () => {
      // Act
      const tags = createOpusTags("werift", ["TITLE=a"]);

      // Assert: vendor string と user comment が長さ付きで書かれる。
      expect(tags).toEqual(
        Buffer.concat([
          Buffer.from("OpusTags"),
          Buffer.from([6, 0, 0, 0]),
          Buffer.from("werift"),
          Buffer.from([1, 0, 0, 0]),
          Buffer.from([7, 0, 0, 0]),
          Buffer.from("TITLE=a"),
        ]),
      );
    });

    test.each([
      // [TOC, 2nd byte, samples]
      [(31 << 3) | 0, 0, 960], // CELT 20ms x1
      [(28 << 3) | 0, 0, 120], // CELT 2.5ms x1
      [(1 << 3) | 1, 0, 1920], // SILK 20ms x2 (code 1)
      [(3 << 3) | 2, 0, 5760], // SILK 60ms x2 (code 2)
      [(13 << 3) | 0, 0, 960], // Hybrid 20ms
      [(31 << 3) | 3, 3, 2880], // CELT 20ms x3 (code 3)
      [(31 << 3) | 3, 7, undefined], // 140ms exceeds 120ms
    ])("packet samples of TOC %i", (toc, count, samples) => {
      // Act / Assert: TOC バイトのフレーム長 × フレーム数が 48kHz サンプル数になる。
      expect(getOpusPacketSamples(Buffer.from([toc, count]))).toBe(samples);
    });
  });
});
