import { FullIntraRequest } from "./fullIntraRequest";
import { PictureLossIndication } from "./pictureLossIndication";
import { RtcpPacketConverter } from "../rtcp";

type Feedback = FullIntraRequest | PictureLossIndication;

export class RtcpPayloadSpecificFeedback {
  static type = 206;
  type = RtcpPayloadSpecificFeedback.type;

  feedback: Feedback;

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

  static deSerialize(data: Buffer, count: number) {
    let feedback: Feedback;

    switch (count) {
      case FullIntraRequest.count:
        feedback = FullIntraRequest.deSerialize(data);
        break;
      case PictureLossIndication.count:
        feedback = PictureLossIndication.deSerialize(data);
        break;
      default:
        console.log(count);
        break;
    }

    return new RtcpPayloadSpecificFeedback({ feedback });
  }
}
