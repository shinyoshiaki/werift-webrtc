import { Signature } from "../../../src/handshake/extensions/signature";
test("handshake_extensions_signature", () => {
  const raw = Buffer.from([
    0x00,
    0x0d,
    0x00,
    0x08,
    0x00,
    0x06,
    0x04,
    0x03,
    0x05,
    0x03,
    0x06,
    0x03,
  ]);
  const c = Signature.deSerialize(raw);
  expect(raw).toEqual(c.serialize());
});
