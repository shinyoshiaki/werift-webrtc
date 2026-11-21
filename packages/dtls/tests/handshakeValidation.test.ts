import { HandshakeValidation } from "../src";
import { validateAndNegotiateClientHello } from "../src/flight/server/commitClientHello";
import { UseSRTP } from "../src/handshake/extensions/useSrtp";
import { createDtls12ClientHello, createEcdsaDtlsServer } from "./utils";

/** use_srtp: profile 0x0001 だけを持ち、MKI 長 1 を宣言して MKI 本体が無い不正な data */
const malformedUseSrtp = Buffer.from([0x00, 0x02, 0x00, 0x01, 0x01]);
/** supported_versions: 長さ 3 を宣言して 2 bytes しか無い不正な data */
const malformedSupportedVersions = Buffer.from([0x03, 0xfe, 0xfd]);

describe("handshakeValidation (DTLS 1.2)", () => {
  test("use_srtp の MKI 長の不整合は standard で失敗し、lenient では宣言どおりの profile を読む", () => {
    // Act / Assert: standard は RFC 5764 の長さを検査して失敗する
    expect(() => UseSRTP.fromData(malformedUseSrtp)).toThrow(/MKI length/);
    // Act / Assert: lenient は従来どおり長さを検査せず profile を読む
    const lenient = UseSRTP.fromData(malformedUseSrtp, { lenient: true });
    expect(lenient.profiles).toEqual([0x0001]);
  });

  test.each([
    [HandshakeValidation.standard, true],
    [HandshakeValidation.lenient, false],
  ] as const)(
    "重複した拡張を持つ ClientHello は %s で失敗するか: %s",
    async (handshakeValidation, rejects) => {
      // Arrange: renegotiation_info を 2 つ持つ ClientHello
      const { server } = await createEcdsaDtlsServer({ handshakeValidation });
      const renegotiationInfo = { type: 0xff01, data: Buffer.from([0x00]) };
      const hello = createDtls12ClientHello([
        renegotiationInfo,
        renegotiationInfo,
      ]);
      try {
        // Act
        const negotiate = () =>
          validateAndNegotiateClientHello(hello, server.dtls, server.cipher);

        // Assert: standard だけが重複を拒否する
        if (rejects) {
          expect(negotiate).toThrow(/duplicate/i);
        } else {
          expect(negotiate).not.toThrow();
        }
      } finally {
        server.close();
      }
    },
  );

  test.each([
    [HandshakeValidation.standard, undefined],
    [HandshakeValidation.lenient, "1.2"],
  ] as const)(
    "不正な supported_versions は %s で %s を選ぶ",
    async (handshakeValidation, selected) => {
      // Arrange: 不正な supported_versions を持つ ClientHello
      const { server } = await createEcdsaDtlsServer({ handshakeValidation });
      const hello = createDtls12ClientHello([
        { type: 43, data: malformedSupportedVersions },
      ]);
      try {
        // Act: ClientHello から DTLS version を選ぶ
        const version = (server as any).selectVersionFromClientHello(hello);

        // Assert: standard は protocol_version（undefined）、lenient は拡張を無視して DTLS 1.2
        expect(version).toBe(selected);
      } finally {
        server.close();
      }
    },
  );

  test("既定値は lenient", async () => {
    // Arrange / Act: handshakeValidation を指定しない server
    const { server } = await createEcdsaDtlsServer();
    const hello = createDtls12ClientHello([
      { type: 43, data: malformedSupportedVersions },
    ]);
    try {
      // Assert: 不正な supported_versions を無視して DTLS 1.2 を選ぶ
      expect((server as any).selectVersionFromClientHello(hello)).toBe("1.2");
    } finally {
      server.close();
    }
  });
});
