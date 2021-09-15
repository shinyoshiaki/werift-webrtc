import { Vp9RtpPayload } from "../../src";

const kMaxOneBytePictureId = 0x7f; // 7 bits
const kMaxTwoBytePictureId = 0x7fff; // 15 bits
const kSsrc1 = 12345;
const kSsrc2 = 23456;
const kPictureId = 123;
const kTl0PicIdx = 20;
const kTemporalIdx = 1;
const kInitialPictureId1 = 222;
const kInitialTl0PicIdx1 = 99;

describe("packages/rtp/tests/codec/vp9.test.ts", () => {
  test("ParseBasicHeader", () => {
    const b = Buffer.alloc(4);
    b[0] = 0x0c; // I:0 P:0 L:0 F:0 B:1 E:1 V:0 Z:0

    const { offset } = Vp9RtpPayload.parseRtpPayload(b);
    expect(offset).toBe(1);
  });

  test("ParseOneBytePictureId", () => {
    const b = Buffer.alloc(10);
    b[0] = 0x80; // I:1 P:0 L:0 F:0 B:0 E:0 V:0 Z:0
    b[1] = kMaxOneBytePictureId;

    const { offset } = Vp9RtpPayload.parseRtpPayload(b);
    expect(offset).toBe(2);
  });

  test("ParseTwoBytePictureId", () => {
    const packet = Buffer.alloc(10);
    packet[0] = 0x80; // I:1 P:0 L:0 F:0 B:0 E:0 V:0 Z:0
    packet[1] = 0x80 | ((kMaxTwoBytePictureId >> 8) & 0x7f);
    packet[2] = kMaxTwoBytePictureId & 0xff;

    const { offset } = Vp9RtpPayload.parseRtpPayload(packet);
    expect(offset).toBe(3);
  });

  test("ParseLayerInfoWithNonFlexibleMode", () => {
    const kTemporalIdx = 2;
    const kUbit = 1;
    const kSpatialIdx = 1;
    const kDbit = 1;
    const kTl0PicIdx = 17;

    const packet = Buffer.alloc(13);
    packet[0] = 0x20; // I:0 P:0 L:1 F:0 B:0 E:0 V:0 Z:0
    packet[1] = (kTemporalIdx << 5) | (kUbit << 4) | (kSpatialIdx << 1) | kDbit;
    packet[2] = kTl0PicIdx;

    const { offset } = Vp9RtpPayload.parseRtpPayload(packet);
    expect(offset).toBe(3);
  });

  test("ParseLayerInfoWithFlexibleMode", () => {
    const kTemporalIdx = 2;
    const kUbit = 1;
    const kSpatialIdx = 0;
    const kDbit = 0;

    const packet = Buffer.alloc(13);
    packet[0] = 0x38; // I:0 P:0 L:1 F:1 B:1 E:0 V:0 Z:0
    packet[1] = (kTemporalIdx << 5) | (kUbit << 4) | (kSpatialIdx << 1) | kDbit;

    const { offset } = Vp9RtpPayload.parseRtpPayload(packet);
    expect(offset).toBe(2);
  });

  test("ParseRefIdx", () => {
    const kPictureId = 17;
    const kPdiff1 = 17;
    const kPdiff2 = 18;
    const kPdiff3 = 127;

    const packet = Buffer.alloc(13);
    packet[0] = 0xd8; // I:1 P:1 L:0 F:1 B:1 E:0 V:0 Z:0
    packet[1] = 0x80 | ((kPictureId >> 8) & 0x7f); // Two byte pictureID.
    packet[2] = kPictureId;
    packet[3] = (kPdiff1 << 1) | 1; // P_DIFF N:1
    packet[4] = (kPdiff2 << 1) | 1; // P_DIFF N:1
    packet[5] = (kPdiff3 << 1) | 0; // P_DIFF N:0

    const { offset } = Vp9RtpPayload.parseRtpPayload(packet);
    expect(offset).toBe(6);
  });

  test("ParseSsData", () => {
    const kYbit = 0;
    const kNs = 2;
    const kNg = 2;

    const packet = Buffer.alloc(23);
    packet[0] = 0x0a; // I:0 P:0 L:0 F:0 B:1 E:0 V:1 Z:0
    packet[1] = ((kNs - 1) << 5) | (kYbit << 4) | (1 << 3); // N_S Y G:1 -
    packet[2] = kNg; // N_G
    packet[3] = (0 << 5) | (1 << 4) | (0 << 2) | 0; // T:0 U:1 R:0 -
    packet[4] = (2 << 5) | (0 << 4) | (1 << 2) | 0; // T:2 U:0 R:1 -
    packet[5] = 33;

    const { offset, p } = Vp9RtpPayload.parseRtpPayload(packet);
    expect(offset).toBe(6);
    expect(p.bBit).toBeTruthy();
    expect(p.vBit).toBeTruthy();
    expect(p.n_s! + 1).toBe(kNs);
    expect(p.n_g).toBe(kNg);
  });

  // use pion test case
  test("ScalabilityStructureResolutionsNoPayload", () => {
    const b = Buffer.from([
      0x0a,
      (1 << 5) | (1 << 4), // NS:1 Y:1 G:0
      640 >> 8,
      640 & 0xff,
      360 >> 8,
      360 & 0xff,
      1280 >> 8,
      1280 & 0xff,
      720 >> 8,
      720 & 0xff,
    ]);
    const p = Vp9RtpPayload.deSerialize(b);
    expect(p.bBit).toBeTruthy();
    expect(p.vBit).toBeTruthy();
    expect(p.n_s).toBe(1);
    expect(p.y).toBeTruthy();
    expect(p.g).toBeFalsy();
    expect(p.n_g).toBe(0);
    expect(p.width).toEqual([640, 1280]);
    expect(p.height).toEqual([360, 720]);
    expect(p.payload.length).toBe(0);
  });
});
