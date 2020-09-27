import { RtcpHeader } from "../header";
import { TransportWideCC } from "./twcc";

type Feedback = TransportWideCC;

export class RtcpTransportLayerFeedback {
  static type = 205;
  type = RtcpTransportLayerFeedback.type;
  feedback: Feedback;
  header: RtcpHeader;

  constructor(props: Partial<RtcpTransportLayerFeedback> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    const payload = this.feedback.serialize();
    return payload;
  }

  static deSerialize(data: Buffer, header: RtcpHeader) {
    let feedback: Feedback;

    switch (header.count) {
      case TransportWideCC.count:
        feedback = TransportWideCC.deSerialize(data, header);
        break;
      default:
        console.log("unknown rtpfb packet", header.count);
        break;
    }

    return new RtcpTransportLayerFeedback({ feedback, header });
  }
}
