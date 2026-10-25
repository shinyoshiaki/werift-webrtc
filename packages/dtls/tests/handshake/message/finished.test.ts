import { Finished } from "../../../src/handshake/message/finished";
test("handshake_message_finished", () => {
  const raw = Buffer.from([
    0x01, 0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    0x0d, 0x0e, 0x0f,
  ]);
  const c = Finished.deSerialize(raw);
  expect(raw).toEqual(c.serialize());
});
