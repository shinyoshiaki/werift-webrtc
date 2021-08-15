import debug from "debug";

import { RtcpHeader } from "../header";
import { GenericNack } from "./nack";
import { TransportWideCC } from "./twcc";

const log = debug("werift/rtp/rtcp/rtpfb/index");

type Feedback = GenericNack | TransportWideCC;

export class RtcpTransportLayerFeedback {
  static readonly type = 205;
  readonly type = RtcpTransportLayerFeedback.type;
  feedback!: Feedback;
  header!: RtcpHeader;

  constructor(props: Partial<RtcpTransportLayerFeedback> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    const payload = this.feedback.serialize();
    return payload;
  }

  static deSerialize(data: Buffer, header: RtcpHeader) {
    let feedback: Feedback | undefined;

    switch (header.count) {
      case GenericNack.count:
        feedback = GenericNack.deSerialize(data, header);
        break;
      case TransportWideCC.count:
        feedback = TransportWideCC.deSerialize(data, header);
        break;
      default:
        log("unknown rtpfb packet", header.count);
        break;
    }

    return new RtcpTransportLayerFeedback({ feedback, header });
  }
}
