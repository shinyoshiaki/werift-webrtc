import { ServerHelloVerifyRequest } from "../../../../src/handshake/message/server/helloVerifyRequest";
test("handshake_message_server_helloVerifyRequest", () => {
  const raw = Buffer.from([
    0xfe,
    0xff,
    0x14,
    0x25,
    0xfb,
    0xee,
    0xb3,
    0x7c,
    0x95,
    0xcf,
    0x00,
    0xeb,
    0xad,
    0xe2,
    0xef,
    0xc7,
    0xfd,
    0xbb,
    0xed,
    0xf7,
    0x1f,
    0x6c,
    0xcd,
  ]);
  const c = ServerHelloVerifyRequest.deSerialize(raw);
  expect(c.version).toEqual({ major: 1, minor: 0 });
  expect(c.cookie).toEqual(
    Buffer.from([
      0x25,
      0xfb,
      0xee,
      0xb3,
      0x7c,
      0x95,
      0xcf,
      0x00,
      0xeb,
      0xad,
      0xe2,
      0xef,
      0xc7,
      0xfd,
      0xbb,
      0xed,
      0xf7,
      0x1f,
      0x6c,
      0xcd,
    ])
  );
  expect(raw).toEqual(c.serialize());
});
