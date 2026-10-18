export type PolyfillSdpType = "offer" | "answer" | "pranswer" | "rollback";

export interface RTCSessionDescriptionInit {
  type: PolyfillSdpType;
  sdp?: string;
}

/**
 * Browser-compatible `RTCSessionDescription` constructor.
 * Core `werift` still exports `(sdp, type)` for backward compatibility.
 */
export class PolyfillRTCSessionDescription {
  readonly type: PolyfillSdpType;
  readonly sdp: string;

  constructor(
    init: RTCSessionDescriptionInit = {} as RTCSessionDescriptionInit,
  ) {
    if (!init?.type) {
      throw new TypeError("RTCSessionDescriptionInit.type is required");
    }
    this.type = init.type;
    this.sdp = init.sdp ?? "";
  }

  toJSON() {
    return {
      type: this.type,
      sdp: this.sdp,
    };
  }
}
