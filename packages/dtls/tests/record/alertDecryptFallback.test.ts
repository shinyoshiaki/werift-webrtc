import { DtlsVersion } from "../../src";
import { ContentType } from "../../src/record/const";
import { DtlsPlaintext } from "../../src/record/message/plaintext";
import { parsePlainText } from "../../src/record/receive";
import { createEcdsaDtlsServer } from "../utils";

/** 鍵が無い状態で復号できない epoch 1 の alert record（中身は平文の fatal handshake_failure） */
const undecryptableAlert = () =>
  new DtlsPlaintext(
    {
      contentType: ContentType.alert,
      protocolVersion: { major: 254, minor: 253 },
      epoch: 1,
      sequenceNumber: 1,
      contentLen: 2,
    },
    Buffer.from([2, 40]),
  );

describe("epoch > 0 の alert を復号できないとき", () => {
  test("DTLS 1.2 のみの association は record を破棄する", async () => {
    // Arrange: DTLS 1.3 を提示しない server（自分の write epoch は 0）
    const { server } = await createEcdsaDtlsServer();
    try {
      // Act / Assert: 復号に失敗した record は平文として読み直さず破棄する（RFC 6347 §4.1.2.1）
      expect(() =>
        parsePlainText(server.dtls, server.cipher)(undecryptableAlert()),
      ).toThrow();
    } finally {
      server.close();
    }
  });

  test("DTLS 1.3 を提示する association は鍵が無い間だけ平文として読む", async () => {
    // Arrange: dual-version probing（DTLS 1.3 / 1.2 を提示、自分の write epoch は 0）
    const { server } = await createEcdsaDtlsServer({
      protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    });
    try {
      // Act
      const records = parsePlainText(
        server.dtls,
        server.cipher,
      )(undecryptableAlert());

      // Assert: pre-key alert として fatal handshake_failure を読む
      expect(records[0]?.type).toBe(ContentType.alert);
      expect(records[0]?.data).toMatchObject({ level: 2, description: 40 });
    } finally {
      server.close();
    }
  });
});
