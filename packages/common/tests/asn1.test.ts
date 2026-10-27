import {
  encodeDer,
  encodeDerInteger,
  encodeDerOid,
  encodeDerPrintableString,
  encodeDerSet,
  encodeDerTime,
  encodePem,
} from "../src/asn1";

const hex = (buf: Buffer) => buf.toString("hex");

describe("asn1", () => {
  test.each([
    ["1.3.101.110", "06032b656e"],
    ["1.2.840.113549.1.1.11", "06092a864886f70d01010b"],
    ["2.5.4.3", "0603550403"],
  ])("encodeDerOid(%s)", (oid, expected) => {
    // Act / Assert: 既知の OID が X.690 のバイト列になる
    expect(hex(encodeDerOid(oid))).toBe(expected);
  });

  test.each(["1", "1.40", "3.1", "1.2.a", ""])(
    "encodeDerOid rejects invalid OID %j",
    (oid) => {
      // Act / Assert: 不正な OID は例外になる
      expect(() => encodeDerOid(oid)).toThrow(TypeError);
    },
  );

  test("encodeDerInteger encodes minimal positive integers", () => {
    // Act / Assert: 0、最上位ビットが立つ値、先頭 0 を含むバッファ
    expect(hex(encodeDerInteger(0))).toBe("020100");
    expect(hex(encodeDerInteger(0x80))).toBe("02020080");
    expect(hex(encodeDerInteger(0x10001))).toBe("0203010001");
    expect(hex(encodeDerInteger(Buffer.from([0, 0, 1])))).toBe("020101");
    expect(hex(encodeDerInteger(Buffer.from([0xff])))).toBe("020200ff");
    // Act / Assert: 負数は扱わない
    expect(() => encodeDerInteger(-1)).toThrow(RangeError);
  });

  test("encodeDer uses long-form length from 128 bytes", () => {
    // Act: 短形式の上限と長形式（1 バイト / 2 バイト長）の境界で符号化する
    const short = encodeDer(0x04, Buffer.alloc(0x7f));
    const long1 = encodeDer(0x04, Buffer.alloc(0x80));
    const long2 = encodeDer(0x04, Buffer.alloc(300));

    // Assert: ヘッダーが X.690 の長さ表現になり、内容がそのまま続く
    expect(hex(short.subarray(0, 2))).toBe("047f");
    expect(hex(long1.subarray(0, 3))).toBe("048180");
    expect(hex(long2.subarray(0, 4))).toBe("0482012c");
    expect(long2.length).toBe(4 + 300);
  });

  test("encodeDerSet sorts elements by encoding", () => {
    // Act: 逆順で渡した要素を SET にする
    const set = encodeDerSet(encodeDerInteger(2), encodeDerInteger(1));

    // Assert: DER の規則どおり昇順に並ぶ
    expect(hex(set)).toBe("3106020101020102");
  });

  test("encodeDerTime switches UTCTime / GeneralizedTime at 2050", () => {
    // Act: 2049 年と 2050 年の時刻を符号化する
    const utc = encodeDerTime(new Date("2049-12-31T23:59:59.999Z"));
    const generalized = encodeDerTime(new Date("2050-01-01T00:00:00Z"));

    // Assert: 2049 年までは UTCTime（秒未満は切り捨て）、2050 年からは GeneralizedTime
    expect(utc[0]).toBe(0x17);
    expect(utc.subarray(2).toString("ascii")).toBe("491231235959Z");
    expect(generalized[0]).toBe(0x18);
    expect(generalized.subarray(2).toString("ascii")).toBe("20500101000000Z");
  });

  test("encodeDerPrintableString rejects characters outside PrintableString", () => {
    // Act / Assert: 許可文字は通り、`@` や非 ASCII は例外になる
    expect(hex(encodeDerPrintableString("AU"))).toBe("13024155");
    expect(() => encodeDerPrintableString("a@b")).toThrow(TypeError);
    expect(() => encodeDerPrintableString("日本")).toThrow(TypeError);
  });

  test("encodePem wraps base64 at 64 characters", () => {
    // Arrange
    const der = Buffer.alloc(100, 0xab);

    // Act: PEM に変換する
    const pem = encodePem("CERTIFICATE", der);
    const lines = pem.trimEnd().split("\n");

    // Assert: ヘッダー / フッター付きで、本文は 64 文字ごとに改行され、元のバイト列に戻る
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines.at(-1)).toBe("-----END CERTIFICATE-----");
    expect(lines.slice(1, -1).map((l) => l.length)).toEqual([64, 64, 8]);
    expect(Buffer.from(lines.slice(1, -1).join(""), "base64")).toEqual(der);
  });
});
