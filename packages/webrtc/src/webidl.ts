// WebIDL value conversions for the browser-compatible entry points
// (`RTCDataChannel.binaryType`, the `RTCSessionDescription` dictionary
// constructor). Internal: not re-exported from the package index.
// https://webidl.spec.whatwg.org/#es-DOMString
// https://webidl.spec.whatwg.org/#es-enumeration
import { createWebRtcTypeError } from "./errors";

/**
 * WebIDL `DOMString` conversion (ECMAScript `ToString`): a Symbol is a
 * `TypeError`; anything else goes through `String()`, so objects use their
 * `toString()` / `valueOf()` and an exception they throw propagates.
 * `null` is `"null"` and `undefined` is `"undefined"` (callers apply a
 * dictionary default before converting).
 */
export function toDOMString(value: unknown, what: string): string {
  if (typeof value === "symbol") {
    throw createWebRtcTypeError(`${what}: cannot convert a Symbol to a string`);
  }
  return String(value);
}

/**
 * WebIDL enumeration conversion: `ToString` first (a Symbol or a throwing
 * `toString()` throws), then the result is matched against `values`.
 * Returns `undefined` when it is not one of them; an attribute setter
 * ignores that, a dictionary member or argument throws `TypeError`.
 */
export function toEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  what: string,
): T | undefined {
  const text = toDOMString(value, what);
  return values.includes(text as T) ? (text as T) : undefined;
}
