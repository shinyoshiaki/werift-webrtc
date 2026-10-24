/**
 * Declarative binary data encoder / decoder.
 *
 * TypeScript port of the subset of `binary-data` used by werift.
 * https://github.com/reklatsmasters/binary-data
 * https://github.com/shinyoshiaki/binary-data
 *
 * MIT License
 *
 * Copyright (c) 2017 Dmitry Tsvettsikh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.types =
  exports.BinaryWriter =
  exports.BinaryReader =
  exports.NotEnoughDataError =
    void 0;
exports.encode = encode;
exports.decode = decode;
/** Thrown when the input does not contain enough bytes to decode. */
class NotEnoughDataError extends Error {
  constructor(expected, received) {
    super(`requested ${expected} bytes but only ${received} available`);
    this.name = "NotEnoughDataError";
  }
}
exports.NotEnoughDataError = NotEnoughDataError;
/** Sequential reader over a single Buffer. Returned buffers share memory with the input. */
class BinaryReader {
  constructor(buf) {
    Object.defineProperty(this, "buf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: buf,
    });
    Object.defineProperty(this, "offset", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
  }
  /** The number of unread bytes. */
  get length() {
    return this.buf.length - this.offset;
  }
  /** The number of bytes consumed so far. */
  get bytes() {
    return this.offset;
  }
  readBuffer(size) {
    this.assertSize(size);
    const res = this.buf.subarray(this.offset, this.offset + size);
    this.offset += size;
    return res;
  }
  readUIntBE(size) {
    this.assertSize(size);
    const res = this.buf.readUIntBE(this.offset, size);
    this.offset += size;
    return res;
  }
  assertSize(size) {
    if (size > this.length) {
      throw new NotEnoughDataError(size, this.length);
    }
  }
}
exports.BinaryReader = BinaryReader;
/** Collects written chunks and concatenates them once at the end. */
class BinaryWriter {
  constructor() {
    Object.defineProperty(this, "chunks", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: [],
    });
    Object.defineProperty(this, "written", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
  }
  /** The number of bytes written so far. */
  get bytes() {
    return this.written;
  }
  writeBuffer(buf) {
    this.chunks.push(buf);
    this.written += buf.length;
  }
  writeUIntBE(value, size) {
    const buf = Buffer.allocUnsafe(size);
    switch (size) {
      case 1:
        buf.writeUInt8(value, 0);
        break;
      case 2:
        buf.writeUInt16BE(value, 0);
        break;
      case 4:
        buf.writeUInt32BE(value, 0);
        break;
      default:
        buf.writeUIntBE(value, 0, size);
    }
    this.writeBuffer(buf);
  }
  toBuffer() {
    return Buffer.concat(this.chunks, this.written);
  }
}
exports.BinaryWriter = BinaryWriter;
const isObject = (value) => typeof value === "object" && value !== null;
const isType = (value) =>
  isObject(value) &&
  typeof value.encode === "function" &&
  typeof value.decode === "function";
const isPlainObject = (value) => {
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const createContext = () => ({
  node: undefined,
  current: undefined,
});
const cloneContext = (context) => ({
  node: context.node,
  current: context.current,
});
const assertSchema = (schema, message) => {
  if (!isPlainObject(schema)) {
    throw new TypeError(message);
  }
};
const encodeCommon = (value, typeOrSchema, writer, context) => {
  if (isType(typeOrSchema)) {
    typeOrSchema.encode(value, writer, context);
  } else {
    encodeSchema(value, typeOrSchema, writer, context);
  }
};
const encodeSchema = (obj, schema, writer, context) => {
  assertSchema(schema, "Argument `schema` should be a plain object.");
  if (context.node === undefined) {
    context.node = obj;
  }
  context.current = obj;
  for (const key of Object.keys(schema)) {
    const type = schema[key];
    const value = obj[key];
    if (isType(type)) {
      type.encode(value, writer, context);
    } else {
      encodeSchema(value, type, writer, context);
      context.current = obj;
    }
  }
};
const decodeCommon = (reader, typeOrSchema, context) => {
  if (isType(typeOrSchema)) {
    return typeOrSchema.decode(reader, context);
  }
  return decodeSchema(reader, typeOrSchema, context);
};
const decodeSchema = (reader, schema, context) => {
  assertSchema(schema, "Argument #2 should be a plain object.");
  const node = Object.create(null);
  if (context.node === undefined) {
    context.node = node;
  }
  context.current = node;
  for (const key of Object.keys(schema)) {
    const type = schema[key];
    if (isType(type)) {
      node[key] = type.decode(reader, context);
    } else {
      node[key] = decodeSchema(reader, type, context);
      context.current = node;
    }
  }
  return node;
};
/** Encode `obj` using a type or schema. */
function encode(obj, typeOrSchema) {
  const writer = new BinaryWriter();
  encodeCommon(obj, typeOrSchema, writer, createContext());
  return writer.toBuffer();
}
/**
 * Decode `buf` using a type or schema.
 * Trailing bytes are ignored. Throws NotEnoughDataError when `buf` is too short.
 */
function decode(buf, typeOrSchema) {
  return decodeCommon(new BinaryReader(buf), typeOrSchema, createContext());
}
const createUIntBE = (size) => ({
  encode: (value, writer) => writer.writeUIntBE(value, size),
  decode: (reader) => reader.readUIntBE(size),
});
const assertLengthSpec = (length) => {
  if (
    typeof length !== "number" &&
    !isType(length) &&
    typeof length !== "function"
  ) {
    throw new TypeError("Unknown type of argument #1.");
  }
};
const checkLength = (required, having, name) => {
  if (required !== having) {
    throw new Error(`${name} required length ${required} instead of ${having}`);
  }
};
const checkLengthType = (length, message) => {
  if (typeof length !== "number") {
    throw new TypeError(message);
  }
};
/**
 * Buffer type.
 * @param length fixed number of bytes, number type for size-prefixed buffers,
 * or callback returning the number of bytes.
 */
function buffer(length) {
  assertLengthSpec(length);
  const lengthTypeError = "Length of a buffer should be a number.";
  return {
    encode(buf, writer, context) {
      if (!Buffer.isBuffer(buf)) {
        throw new TypeError("Argument 1 should be a Buffer or a BinaryStream.");
      }
      if (typeof length === "number") {
        checkLength(length, buf.length, "Buffer");
      } else if (isType(length)) {
        length.encode(buf.length, writer, context);
      } else {
        const expected = length(context);
        checkLengthType(expected, lengthTypeError);
        checkLength(expected, buf.length, "Buffer");
      }
      writer.writeBuffer(buf);
    },
    decode(reader, context) {
      let size;
      if (typeof length === "number") {
        size = length;
      } else if (isType(length)) {
        size = length.decode(reader, context);
      } else {
        size = length(context);
      }
      checkLengthType(size, lengthTypeError);
      return reader.readBuffer(size);
    },
  };
}
/**
 * Array type.
 * @param type type or schema of each item.
 * @param length fixed length, number type for length-prefixed arrays, or callback.
 * @param lengthType `count` (number of items) or `bytes` (number of bytes).
 */
function array(type, length, lengthType = "count") {
  if (!isType(type) && !isPlainObject(type)) {
    throw new TypeError("Argument #1 should be a valid type.");
  }
  assertLengthSpec(length);
  const isLengthInBytes = lengthType === "bytes";
  const sizeTypeError = "Length of an array should be a number.";
  return {
    encode(items, writer, parent) {
      if (!Array.isArray(items)) {
        throw new TypeError("Argument #1 should be an Array.");
      }
      const context = cloneContext(parent);
      let expectedSize = 0;
      if (typeof length === "number") {
        expectedSize = length;
      } else if (isType(length)) {
        expectedSize = items.length;
      } else {
        expectedSize = length(context);
        checkLengthType(expectedSize, sizeTypeError);
      }
      // Encode items first so that the byte length is known for the prefix.
      const body = new BinaryWriter();
      for (const item of items) {
        encodeCommon(item, type, body, context);
      }
      if (isLengthInBytes) {
        if (isType(length)) {
          expectedSize = body.bytes;
        }
        checkLength(body.bytes, expectedSize, "Argument #1");
      } else {
        checkLength(expectedSize, items.length, "Argument #1");
      }
      if (isType(length)) {
        length.encode(expectedSize, writer, context);
      }
      writer.writeBuffer(body.toBuffer());
    },
    decode(reader, parent) {
      const context = cloneContext(parent);
      let expectedSize;
      if (typeof length === "number") {
        expectedSize = length;
      } else if (isType(length)) {
        expectedSize = length.decode(reader, context);
      } else {
        expectedSize = length(context);
      }
      checkLengthType(expectedSize, sizeTypeError);
      const items = [];
      if (isLengthInBytes) {
        const before = reader.bytes;
        let bytes = 0;
        while (bytes < expectedSize) {
          items.push(decodeCommon(reader, type, context));
          bytes = reader.bytes - before;
        }
        if (bytes > expectedSize) {
          throw new Error("Incorrect length of an array.");
        }
      } else {
        for (let i = 0; i < expectedSize; i++) {
          items.push(decodeCommon(reader, type, context));
        }
      }
      return items;
    },
  };
}
/**
 * String type.
 * @param length fixed number of bytes, number type for size-prefixed strings,
 * or callback returning the number of bytes.
 */
function string(length, encoding = "ascii") {
  if (!Buffer.isEncoding(encoding)) {
    throw new Error("Argument #2 should be an encoding name.");
  }
  assertLengthSpec(length);
  const lengthTypeError = "Length of a buffer should be a number.";
  return {
    encode(value, writer, context) {
      const buf = Buffer.from(value.toString(), encoding);
      if (typeof length === "number") {
        if (buf.length !== length) {
          throw new Error(`Size of string should be ${length} in bytes.`);
        }
      } else if (isType(length)) {
        length.encode(buf.length, writer, context);
      } else {
        const expected = length(context);
        checkLengthType(expected, lengthTypeError);
        checkLength(expected, buf.length, "Buffer");
      }
      writer.writeBuffer(buf);
    },
    decode(reader, context) {
      let size;
      if (typeof length === "number") {
        size = length;
      } else if (isType(length)) {
        size = length.decode(reader, context);
        checkLengthType(size, "Size of a string should be a number.");
      } else {
        size = length(context);
        checkLengthType(size, lengthTypeError);
      }
      return reader.readBuffer(size).toString(encoding);
    },
  };
}
exports.types = {
  uint8: createUIntBE(1),
  uint16be: createUIntBE(2),
  uint24be: createUIntBE(3),
  uint32be: createUIntBE(4),
  uint48be: createUIntBE(6),
  buffer,
  array,
  string,
};
//# sourceMappingURL=binaryData.js.map
