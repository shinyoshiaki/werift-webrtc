import { encodeTcpFrame, splitTcpFrames } from "../../src/stun/tcpFrame";

describe("tcpFrame", () => {
  test("frames and splits RFC4571 packets", () => {
    // Arrange: 2 つの独立した payload を RFC 4571 framing で連結する。
    const first = Buffer.from("first");
    const second = Buffer.from("second");
    const framed = Buffer.concat([
      encodeTcpFrame(first),
      encodeTcpFrame(second),
    ]);

    // Act: 連結された TCP バッファをフレーム境界で分割する。
    const { frames, rest } = splitTcpFrames(framed);

    // Assert: 各フレームが元の payload に復元され、未処理バッファは残らない。
    expect(frames).toEqual([first, second]);
    expect(rest).toHaveLength(0);
  });

  test("keeps incomplete trailing frame buffered", () => {
    // Arrange: 完全な 1 フレームと途中までの 1 フレームを同じバッファに載せる。
    const full = encodeTcpFrame(Buffer.from("full"));
    const partial = encodeTcpFrame(Buffer.from("partial")).subarray(0, 4);

    // Act: 途中までのバッファを分割する。
    const { frames, rest } = splitTcpFrames(Buffer.concat([full, partial]));

    // Assert: 完全なフレームだけを返し、不完全な末尾は次回読み取り用に保持する。
    expect(frames).toEqual([Buffer.from("full")]);
    expect(rest).toEqual(partial);
  });
});
