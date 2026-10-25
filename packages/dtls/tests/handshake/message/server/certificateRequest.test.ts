import { ServerCertificateRequest } from "../../../../src/handshake/message/server/certificateRequest";
test("handshake_message_server_certificateRequest", () => {
  const raw = Buffer.from([
    0x02, 0x01, 0x40, 0x00, 0x0c, 0x04, 0x03, 0x04, 0x01, 0x05, 0x03, 0x05,
    0x01, 0x06, 0x01, 0x02, 0x01, 0x00, 0x00,
  ]);
  const c = ServerCertificateRequest.deSerialize(raw);
  expect(raw).toEqual(c.serialize());
});
