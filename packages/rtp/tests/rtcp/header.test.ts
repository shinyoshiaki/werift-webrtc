import { RtcpHeader } from "../../src/rtcp/header";

describe("rtcp/header", () => {
  test("valid", () => {
    const raw = Buffer.from([0x81, 0xc9, 0x00, 0x07]);
    const h = new RtcpHeader({
      version: 2,
      padding: false,
      count: 1,
      type: 201,
      length: 7,
    });
    expect(h.serialize()).toEqual(raw);
    const dec = RtcpHeader.deSerialize(raw);
    expect(raw).toEqual(dec.serialize());
  });
});
