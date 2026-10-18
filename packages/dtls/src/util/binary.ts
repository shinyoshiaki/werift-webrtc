import { binaryData } from "../imports/common";

const { encode } = binaryData;

export function encodeBuffer(obj: object, spec: binaryData.Schema) {
  return encode(obj, spec);
}
