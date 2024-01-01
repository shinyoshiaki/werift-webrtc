import { UseSRTP } from "../../../src/handshake/extensions/useSrtp";

describe("handshake_extensions_useSrtp", () => {
  const raw = Buffer.from([
    0x00, 0x0e, 0x00, 0x05, 0x00, 0x02, 0x00, 0x01, 0x00,
  ]);
  test("raw", () => {
    const c = UseSRTP.deSerialize(raw);
    expect(c.type).toBe(14);
    expect(raw).toEqual(c.serialize());
  });

  test("create", () => {
    const c = UseSRTP.create([1], Buffer.from([0x00]));
    expect(c.serialize()).toEqual(raw);
  });

  test("fromData", () => {
    const c = UseSRTP.deSerialize(raw);
    const ext = c.extension;
    expect(UseSRTP.fromData(ext.data).serialize()).toEqual(raw);
  });
});
