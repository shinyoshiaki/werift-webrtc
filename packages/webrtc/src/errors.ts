export type WebRtcDomExceptionName =
  | "AbortError"
  | "InvalidAccessError"
  | "InvalidModificationError"
  | "InvalidStateError"
  | "NotAllowedError"
  | "NotFoundError"
  | "NotReadableError"
  | "NotSupportedError"
  | "OperationError";

export function createWebRtcDomException(
  name: WebRtcDomExceptionName,
  message: string = name,
) {
  return new DOMException(message, name);
}

export function createWebRtcTypeError(message: string) {
  return new TypeError(message);
}

/**
 * Media Capture and Streams `OverconstrainedError`.
 * WPT `overconstrainederror.html` requires a DOMException subclass with `constraint`.
 */
export class OverconstrainedError extends DOMException {
  readonly constraint: string;

  constructor(constraint: string, message = "") {
    super(message, "OverconstrainedError");
    Object.setPrototypeOf(this, new.target.prototype);
    this.constraint = constraint;
  }
}
