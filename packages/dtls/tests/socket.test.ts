import { DtlsSocket } from "../src";
import { createSocket } from "dgram";
import { DtlsRandom } from "../src/handshake/random";
import { CipherContext } from "../src/context/cipher";
import { SessionType } from "../src/cipher/suites/abstract";

describe("socket", () => {
  test("TestExportKeyingMaterial", () => {
    const exportLabel = "EXTRACTOR-dtls_srtp";

    const expectedServerKey = Buffer.from([
      0x61,
      0x09,
      0x9d,
      0x7d,
      0xcb,
      0x08,
      0x52,
      0x2c,
      0xe7,
      0x7b,
    ]);
    const expectedClientKey = Buffer.from([
      0x87,
      0xf0,
      0x40,
      0x02,
      0xf6,
      0x1c,
      0xf1,
      0xfe,
      0x8c,
      0x77,
    ]);
    const rand = Buffer.alloc(28);

    const socket = new DtlsSocket({ transport: createSocket("udp4") }, false);
    socket.cipher = new CipherContext("", "", SessionType.CLIENT);
    socket.cipher.localRandom = new DtlsRandom(500, rand);
    socket.cipher.remoteRandom = new DtlsRandom(1000, rand);
    socket.cipher.masterSecret = Buffer.from([]);
    socket.cipher.cipherSuite = 0xc02b;

    expect(socket.exportKeyingMaterial(exportLabel, 10)).toEqual(
      expectedServerKey
    );

    socket.isClient = true;
    expect(socket.exportKeyingMaterial(exportLabel, 10)).toEqual(
      expectedClientKey
    );
  });
});
