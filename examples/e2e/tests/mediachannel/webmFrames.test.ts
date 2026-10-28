import {
  countSavedInOrder,
  readWebmFrames,
} from "../../../mediachannel/latency_budget/webmFrames.js";

/** Arrange: werift の webm と同じ並び (サイズ不明の Segment / Cluster の後に SimpleBlock) を組み立てる */
function webm(payloads: Buffer[]) {
  const unknownSize = Buffer.from([
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  const ebmlHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x82, 0x42, 0x86]);
  const segment = Buffer.concat([
    Buffer.from([0x18, 0x53, 0x80, 0x67]),
    unknownSize,
  ]);
  // 中身を持つ要素 (Info) はサイズで読み飛ばされる
  const info = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x83, 0x2a, 0xd7, 0xb1]);
  const cluster = Buffer.concat([
    Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
    unknownSize,
    // Timecode = 0
    Buffer.from([0xe7, 0x81, 0x00]),
  ]);
  const blocks = payloads.map((payload, i) =>
    Buffer.concat([
      Buffer.from([0xa3, 0x80 | (4 + payload.length), 0x81, 0x00, i, 0x80]),
      payload,
    ]),
  );
  return Buffer.concat([ebmlHeader, segment, info, cluster, ...blocks]);
}

describe("latency_budget readWebmFrames", () => {
  // 無音の Opus フレームのような、短く同一の payload を含む
  const silence = Buffer.from([0xf8, 0xff, 0xfe]);
  const payloads = [
    silence,
    silence,
    Buffer.from("frame-2-tone"),
    silence,
    Buffer.from("frame-4-tone"),
  ];

  test("保存された全フレームを、ファイル内の順序どおり payload ごと取り出す", () => {
    // Act
    const frames = readWebmFrames(webm(payloads));

    // Assert
    expect(frames.map((f) => f.track)).toEqual([1, 1, 1, 1, 1]);
    expect(frames.map((f) => f.payload)).toEqual(payloads);
    expect(countSavedInOrder(frames, payloads)).toBe(5);
  });

  test("順序が入れ替わった、または欠けた録音は、短く同一の payload でも一致数が減る", () => {
    // Act
    const swapped = readWebmFrames(
      webm([payloads[0], payloads[1], payloads[3], payloads[4], payloads[2]]),
    );
    const missing = readWebmFrames(
      webm([payloads[0], payloads[2], payloads[3], payloads[4]]),
    );

    // Assert: 位置ごとの比較なので、同じ無音 payload が別の位置で一致したとはみなさない
    expect(countSavedInOrder(swapped, payloads)).toBe(2);
    expect(countSavedInOrder(missing, payloads)).toBe(1);
    expect(missing.length).toBe(4);
  });
});
