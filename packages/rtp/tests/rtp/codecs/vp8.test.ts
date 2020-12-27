import { VP8 } from "../../../src/rtp/codecs/vp8";

describe("vp8", () => {
  test("normal", () => {
    const p = VP8.deSerialize(
      Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x90])
    );
    expect(p.payload).toBeTruthy();
  });

  test("payload", () => {
    const payload = Buffer.from([0x90, 0x90, 0x90]);
    let res = VP8.payLoader(1, [] as any);
    expect(res.length).toBe(0);

    res = VP8.payLoader(1, payload);
    expect(res.length).toBe(0);

    res = VP8.payLoader(-1, payload);
    expect(res.length).toBe(0);

    res = VP8.payLoader(2, payload);
    expect(res.length).toBe(payload.length);
  });

  test("head", () => {
    // expect(VP8.isPartitionHead(Buffer.from([0x00]))).toBe(false);
    expect(VP8.isPartitionHead(Buffer.from([0x10, 0x00, 0x00, 0x00]))).toBe(
      true
    );
    expect(VP8.isPartitionHead(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(
      false
    );
  });
});
