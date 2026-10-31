import { describe, expect, test } from "vitest";

import { decodeVintEncodedNumber } from "../../src/extra/container/webm/ebml/ebml";
import {
  ClusterSizeOffset,
  replaceClusterSize,
} from "../../src/extra/processor/webm";
import {
  createWebmFrames,
  isFfprobeAvailable,
  probeWebmWarnings,
  readCueClusterPositions,
  readEbmlChildren,
  readEbmlElementHeader,
  recordWebm,
} from "../utils";

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  cluster: 0x1f43b675,
  cues: 0x1c53bb6b,
};

describe("WebM cluster size", () => {
  test("replaceClusterSize keeps the 8 byte width of the unknown size", () => {
    // Act
    // 小さいサイズでも 8 byte 固定幅の VINT になること
    const resize = replaceClusterSize(1234);

    // Assert
    // 先頭は 8 byte 長のマーカー 0x01 で、値として 1234 が復号できる
    expect(resize.length).toBe(8);
    expect(resize[0]).toBe(0x01);
    expect(decodeVintEncodedNumber(resize).value).toBe(1234);
    expect(ClusterSizeOffset).toBe(4);
  });

  test("saveToFileSystem writes every Cluster with a known size", async () => {
    // Arrange
    const frames = createWebmFrames(3_000, 30);

    // Act
    // saveToFileSystem 経由でファイルに保存する
    const buf = await recordWebm(frames, "file");

    // Assert
    // トップレベルは EBML header と確定サイズの Segment で、ファイル末尾で終わる
    const [ebml] = readEbmlChildren(buf, {
      id: 0,
      position: 0,
      dataPosition: 0,
      size: buf.length,
    });
    expect(ebml.id).toBe(ID.ebml);
    const segment = readEbmlElementHeader(buf, ebml.dataPosition + ebml.size!);
    expect(segment.id).toBe(ID.segment);
    expect(segment.dataPosition + segment.size!).toBe(buf.length);

    // Segment 直下を size だけで辿り、Cluster* → Cues の順に到達できる
    const children = readEbmlChildren(buf, segment);
    const clusters = children.filter((e) => e.id === ID.cluster);
    expect(clusters.length).toBe(4);
    expect(clusters.every((c) => c.size !== undefined)).toBe(true);
    const cues = children.at(-1)!;
    expect(cues.id).toBe(ID.cues);

    // 各 Cluster の終端が次の Cluster / Cues の先頭と一致する
    const following = [...clusters.slice(1), cues];
    clusters.forEach((cluster, i) => {
      expect(cluster.dataPosition + cluster.size!).toBe(following[i].position);
    });

    // CueClusterPosition は引き続き各 Cluster の先頭を指す
    const cuePositions = readCueClusterPositions(buf, cues);
    expect(cuePositions).toEqual(
      clusters.map((c) => c.position - segment.dataPosition),
    );
  });

  test.skipIf(!isFfprobeAvailable())(
    "ffprobe does not warn about unknown-sized Clusters",
    async () => {
      // Arrange
      const frames = createWebmFrames(3_000, 30);

      // Act
      // 保存したファイルを ffprobe で読み込む
      const buf = await recordWebm(frames, "file");
      const warnings = probeWebmWarnings(buf);

      // Assert
      // 確定サイズの親の中に unknown size の要素があるという警告が出ない
      expect(warnings).not.toContain("Unknown-sized element");
    },
  );

  test("streaming output keeps unknown size Segment and Clusters", async () => {
    // Arrange
    const frames = createWebmFrames(3_000, 30);

    // Act
    // 出力チャンクをそのまま連結する (ストリーミングと同じ形)
    const buf = await recordWebm(frames, "stream");

    // Assert
    // Segment と最初の Cluster は unknown size のまま
    const ebml = readEbmlElementHeader(buf, 0);
    const segment = readEbmlElementHeader(buf, ebml.dataPosition + ebml.size!);
    expect(segment.id).toBe(ID.segment);
    expect(segment.size).toBeUndefined();
    const cluster = readEbmlChildren(buf, segment).at(-1)!;
    expect(cluster.id).toBe(ID.cluster);
    expect(cluster.size).toBeUndefined();
  });
});
