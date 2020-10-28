import { range } from "lodash";
import { uint16Add } from "../../utils";
import { RtpPacket } from "../../vendor/rtp";
import { RtcpTransportLayerFeedback } from "../../vendor/rtp/rtcp/rtpfb";
import { GenericNack } from "../../vendor/rtp/rtcp/rtpfb/nack";
import { RTCRtpReceiver } from "./rtpReceiver";

export class Nack {
  private newEstSeqNum = 0;
  private _lost: { [seqNum: number]: number } = {};

  mediaSsrc: number;

  constructor(private receiver: RTCRtpReceiver) {
    setInterval(() => this.packetLost(), 20);
  }

  get lost() {
    return Object.keys(this._lost).map(Number);
  }

  onPacket(packet: RtpPacket) {
    const { sequenceNumber, ssrc } = packet.header;
    this.mediaSsrc = ssrc;

    if (this.newEstSeqNum === 0) {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    if (this._lost[sequenceNumber]) {
      delete this._lost[sequenceNumber];
      return;
    }

    if (sequenceNumber === uint16Add(this.newEstSeqNum, 1)) {
      this.newEstSeqNum = sequenceNumber;
    } else if (sequenceNumber > uint16Add(this.newEstSeqNum, 1)) {
      // packet lost detected
      range(this.newEstSeqNum + 1, sequenceNumber).forEach((seq) => {
        this._lost[seq] = 1;
      });
      this.receiver.sendRtcpPLI(this.mediaSsrc);

      this.newEstSeqNum = sequenceNumber;

      if (Object.keys(this._lost).length > 1000) {
        this._lost = Object.entries(this._lost)
          .slice(-1000)
          .reduce((acc, [key, v]) => {
            acc[key] = v;
            return acc;
          }, {} as { [seqNum: number]: number });
      }
    }
  }

  private increment() {
    Object.keys(this._lost).forEach((seq) => {
      if (++this._lost[seq] > 10) {
        console.log("lost failed", seq);
        delete this._lost[seq];
      }
    });
  }

  private packetLost() {
    if (this.lost.length > 0 && this.mediaSsrc) {
      const rtcp = new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          senderSsrc: this.receiver.rtcpSsrc,
          mediaSsrc: this.mediaSsrc,
          lost: this.lost,
        }),
      });
      this.receiver.dtlsTransport.sendRtcp([rtcp]);

      this.increment();
    }
  }
}
