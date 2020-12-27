import { encode } from "binary-data";

export function encodeBuffer(obj: object, spec: object) {
  return Buffer.from(encode(obj, spec).slice());
}
