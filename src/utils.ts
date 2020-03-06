import { jspack } from "jspack";
import { randomBytes } from "crypto";

export function generateUUID(): string {
  return new Array(4)
    .fill(0)
    .map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16))
    .join("-");
}

export function random32() {
  return jspack.Unpack("!L", randomBytes(4))[0];
}
