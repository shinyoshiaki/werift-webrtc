import { random16, random32, uint16Add, uint32Add } from "../../common/src";
import { RtpHeader, RtpPacket } from "./rtp/rtp";

export class RtpBuilder {
  sequenceNumber = random16();
  timestamp = random32();

  constructor(
    private props: {
      between: number;
      clockRate: number;
    }
  ) {}

  create(payload: Buffer) {
    this.sequenceNumber = uint16Add(this.sequenceNumber, 1);
    const elapsed = (this.props.between * this.props.clockRate) / 1000;
    this.timestamp = uint32Add(this.timestamp, elapsed);

    const header = new RtpHeader({
      sequenceNumber: this.sequenceNumber,
      timestamp: Number(this.timestamp),
      payloadType: 96,
      extension: true,
      marker: false,
      padding: false,
    });
    const rtp = new RtpPacket(header, payload);
    return rtp;
  }
}
