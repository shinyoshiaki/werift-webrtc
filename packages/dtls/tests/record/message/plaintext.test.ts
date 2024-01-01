import { DtlsPlaintext } from "../../../src/record/message/plaintext";
describe("record_message_plaintext", () => {
  test("Change_Cipher_Spec_single_packet", () => {
    const raw = Buffer.from([
      0x14, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0x00,
      0x01, 0x01,
    ]);
    const c = DtlsPlaintext.deSerialize(raw);
    expect(c.recordLayerHeader.contentType).toBe(20);
    expect(c.recordLayerHeader.protocolVersion).toEqual({
      major: 0xfe,
      minor: 0xff,
    });
    expect(c.recordLayerHeader.epoch).toBe(0);
    expect(c.recordLayerHeader.sequenceNumber).toBe(18);
    const expected = c.serialize();
    expect(raw).toEqual(expected);
  });
});
