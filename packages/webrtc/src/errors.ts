export type WebRtcDomExceptionName =
  | "InvalidAccessError"
  | "InvalidModificationError"
  | "InvalidStateError"
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
