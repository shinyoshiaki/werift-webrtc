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
/** Thrown when the input does not contain enough bytes to decode. */
export declare class NotEnoughDataError extends Error {
  constructor(expected: number, received: number);
}
/** Sequential reader over a single Buffer. Returned buffers share memory with the input. */
export declare class BinaryReader {
  private readonly buf;
  private offset;
  constructor(buf: Buffer);
  /** The number of unread bytes. */
  get length(): number;
  /** The number of bytes consumed so far. */
  get bytes(): number;
  readBuffer(size: number): Buffer;
  readUIntBE(size: number): number;
  private assertSize;
}
/** Collects written chunks and concatenates them once at the end. */
export declare class BinaryWriter {
  private readonly chunks;
  private written;
  /** The number of bytes written so far. */
  get bytes(): number;
  writeBuffer(buf: Buffer): void;
  writeUIntBE(value: number, size: number): void;
  toBuffer(): Buffer;
}
/**
 * Encode / decode context.
 * `node` is the root object, `current` is the object currently being processed.
 */
export interface BinaryContext {
  node: any;
  current: any;
}
export interface DataType<T> {
  encode(value: T, writer: BinaryWriter, context: BinaryContext): void;
  decode(reader: BinaryReader, context: BinaryContext): T;
}
export type NumberType = DataType<number>;
export interface Schema {
  [key: string]: DataType<any> | Schema;
}
export type TypeOrSchema = DataType<any> | Schema;
/** Infer the decoded value from a type or schema. */
export type Decoded<S> =
  S extends DataType<infer T>
    ? T
    : S extends Schema
      ? {
          -readonly [K in keyof S]: Decoded<S[K]>;
        }
      : never;
export type LengthCallback = (context: BinaryContext) => number;
/** Encode `obj` using a type or schema. */
export declare function encode(obj: any, typeOrSchema: TypeOrSchema): Buffer;
/**
 * Decode `buf` using a type or schema.
 * Trailing bytes are ignored. Throws NotEnoughDataError when `buf` is too short.
 */
export declare function decode<S extends TypeOrSchema>(
  buf: Buffer,
  typeOrSchema: S,
): Decoded<S>;
type LengthSpec = number | NumberType | LengthCallback;
/**
 * Buffer type.
 * @param length fixed number of bytes, number type for size-prefixed buffers,
 * or callback returning the number of bytes.
 */
declare function buffer(length: LengthSpec): DataType<Buffer>;
/**
 * Array type.
 * @param type type or schema of each item.
 * @param length fixed length, number type for length-prefixed arrays, or callback.
 * @param lengthType `count` (number of items) or `bytes` (number of bytes).
 */
declare function array<S extends TypeOrSchema>(
  type: S,
  length: LengthSpec,
  lengthType?: "count" | "bytes",
): DataType<Decoded<S>[]>;
/**
 * String type.
 * @param length fixed number of bytes, number type for size-prefixed strings,
 * or callback returning the number of bytes.
 */
declare function string(
  length: LengthSpec,
  encoding?: BufferEncoding,
): DataType<string>;
export declare const types: {
  uint8: NumberType;
  uint16be: NumberType;
  uint24be: NumberType;
  uint32be: NumberType;
  uint48be: NumberType;
  buffer: typeof buffer;
  array: typeof array;
  string: typeof string;
};
