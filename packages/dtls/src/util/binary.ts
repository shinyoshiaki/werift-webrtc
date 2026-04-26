import { encode } from "@shinyoshiaki/binary-data";

export function encodeBuffer(obj: object, spec: object) {
  return Buffer.from(encode(obj, spec).slice());
}
