export class RTCSessionDescription {
  constructor(public sdp: string, public type: "offer" | "answer") {}
}
