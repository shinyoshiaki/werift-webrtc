import { ServerHello } from "../../../../src/handshake/message/server/hello";

test("handshake_message_server_hello", () => {
  const rawServerHello = Buffer.from([
    0xfe,
    0xfd,
    0x21,
    0x63,
    0x32,
    0x21,
    0x81,
    0x0e,
    0x98,
    0x6c,
    0x85,
    0x3d,
    0xa4,
    0x39,
    0xaf,
    0x5f,
    0xd6,
    0x5c,
    0xcc,
    0x20,
    0x7f,
    0x7c,
    0x78,
    0xf1,
    0x5f,
    0x7e,
    0x1c,
    0xb7,
    0xa1,
    0x1e,
    0xcf,
    0x63,
    0x84,
    0x28,
    0x00,
    0xc0,
    0x2b,
    0x00,
    0x00,
    0x00,
  ]);
  const parsed = ServerHello.createEmpty();
  parsed.serverVersion = { major: 0xfe, minor: 0xfd };
  parsed.random = {
    gmt_unix_time: 560149025,
    random_bytes: Buffer.from([
      0x81,
      0x0e,
      0x98,
      0x6c,
      0x85,
      0x3d,
      0xa4,
      0x39,
      0xaf,
      0x5f,
      0xd6,
      0x5c,
      0xcc,
      0x20,
      0x7f,
      0x7c,
      0x78,
      0xf1,
      0x5f,
      0x7e,
      0x1c,
      0xb7,
      0xa1,
      0x1e,
      0xcf,
      0x63,
      0x84,
      0x28,
    ]),
  };
  parsed.compressionMethod = 0;

  const c = ServerHello.deSerialize(rawServerHello);
  expect(parsed.serverVersion).toEqual(c.serverVersion);
  expect(parsed.random).toEqual(c.random);
  expect(parsed.compressionMethod).toEqual(c.compressionMethod);
  const buf = c.serialize();
  expect(buf).toEqual(rawServerHello);
});
