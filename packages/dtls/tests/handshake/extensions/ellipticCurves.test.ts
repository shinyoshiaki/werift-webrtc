import { EllipticCurves } from "../../../src/handshake/extensions/ellipticCurves";
test("handshake_extensions_ellipticCurves", () => {
  const raw = Buffer.from([0x0, 0xa, 0x0, 0x4, 0x0, 0x2, 0x0, 0x1d]);
  const c = EllipticCurves.deSerialize(raw);
  expect(raw).toEqual(c.serialize());
});
