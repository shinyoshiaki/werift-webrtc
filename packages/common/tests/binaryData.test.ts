import { binaryData } from "../src";
import { createBinaryDataFixture } from "./utils";

const { encode, decode, types, NotEnoughDataError, BinaryReader } = binaryData;

describe("binaryData", () => {
  describe("encode / decode", () => {
    test("matches bytes produced by the legacy binary-data package", () => {
      // Arrange
      const { spec, value, legacyEncoded } = createBinaryDataFixture();

      // Act: 移植版で encode する
      const encoded = encode(value, spec);

      // Assert: 移植前ライブラリの出力とバイト単位で一致すること
      expect(encoded.toString("hex")).toBe(legacyEncoded.toString("hex"));
    });

    test("round trips every supported type", () => {
      // Arrange
      const { spec, value } = createBinaryDataFixture();

      // Act: encode した結果を decode し直す
      const decoded = decode(encode(value, spec), spec);

      // Assert: 元の値と同じ内容に復元されること
      expect({ ...decoded, version: { ...decoded.version } }).toEqual(value);
      // Assert: ネストスキーマの要素も復元されること
      expect(decoded.list.map((v) => ({ ...v }))).toEqual(value.list);
    });

    test.each([
      ["uint8", types.uint8, 0xff, "ff"],
      ["uint16be", types.uint16be, 0x0102, "0102"],
      ["uint24be", types.uint24be, 0x010203, "010203"],
      ["uint32be", types.uint32be, 0x01020304, "01020304"],
      ["uint48be", types.uint48be, 0x010203040506, "010203040506"],
    ])("%s is big-endian", (_, type, value, hex) => {
      // Act: 単体の数値型で encode / decode する
      const encoded = encode(value, type);
      const decoded = decode(encoded, type);

      // Assert: big-endian のバイト列になり、同じ値に戻ること
      expect(encoded.toString("hex")).toBe(hex);
      expect(decoded).toBe(value);
    });

    test("keeps decoded keys in schema order", () => {
      // Arrange
      const { spec, value } = createBinaryDataFixture();

      // Act
      const decoded = decode(encode(value, spec), spec);

      // Assert: キー順がスキーマ定義順であること (Object.values で位置引数に渡すため)
      expect(Object.keys(decoded)).toEqual(Object.keys(spec));
      // Assert: プロトタイプを持たないオブジェクトであること
      expect(Object.getPrototypeOf(decoded)).toBeNull();
    });

    test("ignores trailing bytes on decode", () => {
      // Arrange
      const spec = { a: types.uint8, b: types.uint16be };
      const buf = Buffer.from([1, 0, 2, 0xff, 0xff]);

      // Act: 末尾に余分なデータがあるバッファを decode する
      const decoded = decode(buf, spec);

      // Assert: エラーにならず先頭から必要な分だけ読むこと
      expect({ ...decoded }).toEqual({ a: 1, b: 2 });
    });

    test("decoded buffers share memory with the input", () => {
      // Arrange
      const spec = { data: types.buffer(types.uint8) };
      const buf = Buffer.from([2, 0xaa, 0xbb]);

      // Act
      const decoded = decode(buf, spec);
      buf[1] = 0x00;

      // Assert: 移植前と同様に入力バッファとメモリを共有していること
      expect(decoded.data[0]).toBe(0x00);
    });

    test("encode returns a fresh buffer", () => {
      // Arrange
      const data = Buffer.from([1, 2]);

      // Act
      const encoded = encode({ data }, { data: types.buffer(2) });
      data[0] = 0xff;

      // Assert: 入力 Buffer とメモリを共有しないこと
      expect(encoded[0]).toBe(1);
    });

    test("array length callback and context node", () => {
      // Arrange
      const spec = {
        count: types.uint8,
        inner: {
          size: types.uint8,
          body: types.buffer((ctx) => ctx.current.size),
          tail: types.buffer((ctx) => ctx.node.count),
        },
        items: types.array(types.uint8, (ctx) => ctx.current.count),
      };
      const value = {
        count: 2,
        inner: {
          size: 1,
          body: Buffer.from([9]),
          tail: Buffer.from([7, 7]),
        },
        items: [3, 4],
      };

      // Act
      const encoded = encode(value, spec);
      const decoded = decode(encoded, spec);

      // Assert: ctx.current はネスト中のオブジェクト、ctx.node はルートを指すこと
      expect(encoded.toString("hex")).toBe("020109070703" + "04");
      expect(decoded.inner.tail).toEqual(Buffer.from([7, 7]));
      expect(decoded.items).toEqual([3, 4]);
    });

    test("string with fixed length", () => {
      // Arrange
      const type = types.string(3);

      // Act
      const decoded = decode(encode("abc", type), type);

      // Assert
      expect(decoded).toBe("abc");
      // Assert: 長さが異なる文字列は encode できないこと
      expect(() => encode("ab", type)).toThrow(
        "Size of string should be 3 in bytes.",
      );
    });
  });

  describe("errors", () => {
    test("throws NotEnoughDataError when data is short", () => {
      // Arrange
      const spec = { a: types.uint8, b: types.uint32be };
      const buf = Buffer.from([1, 0, 0]);

      // Act / Assert: データ不足で NotEnoughDataError が投げられること
      expect(() => decode(buf, spec)).toThrow(NotEnoughDataError);
      expect(() => decode(buf, spec)).toThrow(
        "requested 4 bytes but only 2 available",
      );
    });

    test("throws NotEnoughDataError when buffer prefix exceeds data", () => {
      // Arrange
      const buf = Buffer.from([5, 1, 2]);

      // Act / Assert: 長さプレフィックス分のデータが無ければ例外となること
      expect(() => decode(buf, types.buffer(types.uint8))).toThrow(
        NotEnoughDataError,
      );
    });

    test("throws Error on fixed buffer length mismatch", () => {
      // Act / Assert: 固定長と異なる長さの Buffer は Error になること
      expect(() =>
        encode({ a: Buffer.from([1]) }, { a: types.buffer(2) }),
      ).toThrow("Buffer required length 2 instead of 1");
    });

    test("throws Error on callback buffer length mismatch", () => {
      // Arrange
      const spec = {
        len: types.uint8,
        data: types.buffer((ctx) => ctx.current.len),
      };

      // Act / Assert: コンテキスト参照長と一致しない場合は Error になること
      expect(() => encode({ len: 3, data: Buffer.from([1]) }, spec)).toThrow(
        "Buffer required length 3 instead of 1",
      );
    });

    test("throws TypeError when value is not a Buffer", () => {
      // Act / Assert: Buffer 以外を buffer 型に渡すと TypeError になること
      expect(() => encode({ a: "x" }, { a: types.buffer(1) })).toThrow(
        TypeError,
      );
    });

    test("throws TypeError when value is not an Array", () => {
      // Act / Assert: 配列以外を array 型に渡すと TypeError になること
      expect(() =>
        encode({ a: 1 }, { a: types.array(types.uint8, types.uint8, "bytes") }),
      ).toThrow(TypeError);
    });

    test("throws Error when array items exceed the byte length", () => {
      // Arrange: バイト長 3 は uint16be 要素 (2 バイト) の倍数ではない
      const buf = Buffer.from([3, 0, 1, 0, 2]);
      const type = types.array(types.uint16be, types.uint8, "bytes");

      // Act / Assert: 指定バイト数を超えて読んだ場合は Error になること
      expect(() => decode(buf, type)).toThrow("Incorrect length of an array.");
    });

    test("throws RangeError on out of range numbers", () => {
      // Act / Assert: 数値範囲外は Node の Buffer と同様に RangeError となること
      expect(() => encode(0x100, types.uint8)).toThrow(RangeError);
      expect(() => encode(0x1000000, types.uint24be)).toThrow(RangeError);
    });
  });

  describe("BinaryReader", () => {
    test("reads buffers sequentially", () => {
      // Arrange
      const reader = new BinaryReader(Buffer.from([1, 2, 3, 4, 5]));

      // Act
      const a = reader.readBuffer(2);
      const b = reader.readBuffer(3);

      // Assert: 先頭から順に切り出されること
      expect(a).toEqual(Buffer.from([1, 2]));
      expect(b).toEqual(Buffer.from([3, 4, 5]));
      // Assert: 読み切った後はデータ不足例外になること
      expect(() => reader.readBuffer(1)).toThrow(NotEnoughDataError);
    });
  });
});
