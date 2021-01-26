import { FullIntraRequest } from "./fullIntraRequest";
import { PictureLossIndication } from "./pictureLossIndication";
import { RtcpPacketConverter } from "../rtcp";
import { RtcpHeader } from "../header";
import { ReceiverEstimatedMaxBitrate } from "./remb";

type Feedback =
  | FullIntraRequest
  | PictureLossIndication
  | ReceiverEstimatedMaxBitrate;

export class RtcpPayloadSpecificFeedback {
  static type = 206;
  type = RtcpPayloadSpecificFeedback.type;

  feedback!: Feedback;

  constructor(props: Partial<RtcpPayloadSpecificFeedback> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    const payload = this.feedback.serialize();
    return RtcpPacketConverter.serialize(
      this.type,
      this.feedback.count,
      payload,
      this.feedback.length
    );
  }

  static deSerialize(data: Buffer, header: RtcpHeader) {
    let feedback: Feedback | undefined;

    switch (header.count) {
      case FullIntraRequest.count:
        feedback = FullIntraRequest.deSerialize(data);
        break;
      case PictureLossIndication.count:
        feedback = PictureLossIndication.deSerialize(data);
        break;
      case ReceiverEstimatedMaxBitrate.count:
        feedback = ReceiverEstimatedMaxBitrate.deSerialize(data);
        break;
      default:
        console.log("unknown psfb packet", header.count);
        break;
    }

    return new RtcpPayloadSpecificFeedback({ feedback });
  }
}
