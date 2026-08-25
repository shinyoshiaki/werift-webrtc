import { crc32 } from "../../src/imports/common";
import {
  decodeSpedAck,
  decodeSpedData,
  encodeSpedAck,
  encodeSpedData,
  spedDataCrc32,
} from "../../src/sped/draft00";
import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
} from "../../src/sped/draft00/constants";

describe("SPED draft00 codec", () => {
  it("empty DATA は advertisement であり datagram ではない", () => {
    // Arrange
    const encoded = encodeSpedData(Buffer.alloc(0));

    // Act
    const decoded = decodeSpedData(encoded.value);

    // Assert
    expect(encoded.type).toBe(DTLS_IN_STUN_DATA);
    expect(decoded.kind).toBe("empty");
  });

  it("先頭 byte が 20–63 以外の DATA は invalid-demux", () => {
    // Arrange
    const rtpLike = Buffer.from([0x80, 0x01, 0x02]);

    // Act
    const decoded = decodeSpedData(rtpLike);

    // Assert: RFC 9443 demux。inject / L2 に載せない
    expect(decoded.kind).toBe("invalid-demux");
  });

  it("DTLS content-type 範囲の DATA は 1 datagram として返す", () => {
    // Arrange
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00]);

    // Act
    const decoded = decodeSpedData(hello);

    // Assert
    expect(decoded.kind).toBe("datagram");
    if (decoded.kind === "datagram") {
      expect(decoded.bytes.equals(hello)).toBe(true);
    }
  });

  it("ACK は empty / 1 / 4 を受信順で返し、非 4 倍数は ignore", () => {
    // Arrange
    const crcs = [1, 2, 3, 4].map((n) => n >>> 0);

    // Act
    const empty = decodeSpedAck(Buffer.alloc(0));
    const four = decodeSpedAck(encodeSpedAck(crcs).value);
    const malformed = decodeSpedAck(Buffer.from([1, 2, 3]));

    // Assert
    expect(encodeSpedAck([]).type).toBe(DTLS_IN_STUN_ACK);
    expect(empty).toEqual({ kind: "crcs", crcs: [] });
    expect(four).toEqual({ kind: "crcs", crcs });
    expect(malformed.kind).toBe("ignore");
  });

  it("ACK 5 件以上は先頭 4 だけ採用する", () => {
    // Arrange: 5 CRC を big-endian で並べる
    const value = Buffer.alloc(20);
    for (let i = 0; i < 5; i++) {
      value.writeUInt32BE(i + 1, i * 4);
    }

    // Act
    const decoded = decodeSpedAck(value);

    // Assert
    expect(decoded).toEqual({ kind: "crcs", crcs: [1, 2, 3, 4] });
  });

  it("送信 ACK は hard cap 4", () => {
    // Arrange / Act
    const encoded = encodeSpedAck([1, 2, 3, 4, 5]);

    // Assert
    expect(encoded.value.length).toBe(16);
    expect(decodeSpedAck(encoded.value)).toEqual({
      kind: "crcs",
      crcs: [1, 2, 3, 4],
    });
  });

  it("CRC-32 は DATA value のみで Fingerprint XOR しない", () => {
    // Arrange
    const dataValue = Buffer.from([22, 1, 2, 3]);

    // Act
    const crc = spedDataCrc32(dataValue);

    // Assert
    expect(crc).toBe(crc32(dataValue) >>> 0);
    expect(crc).not.toBe((crc32(dataValue) ^ 0x5354554e) >>> 0);
  });
});
