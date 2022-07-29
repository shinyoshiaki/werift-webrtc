import range from 'lodash/range';
import Event from 'rx.mini';

import { uint16Add } from '../../../../common/src';
import { GenericNack, RtcpTransportLayerFeedback, RtpPacket } from '../../../../rtp/src';
import { RTCRtpReceiver } from '../rtpReceiver';

const LOST_SIZE = 30 * 5;

export class Nack {
  private newEstSeqNum = 0;
  private _lost: { [seqNum: number]: number } = {};
  private nackLoop = setInterval(() => this.packetLost(), 20);

  readonly onPacketLost = new Event<[GenericNack]>();
  mediaSourceSsrc?: number;

  constructor(private receiver: RTCRtpReceiver) {}

  get lost() {
    return Object.keys(this._lost).map(Number);
  }

  addPacket(packet: RtpPacket) {
    const { sequenceNumber, ssrc } = packet.header;
    this.mediaSourceSsrc = ssrc;

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
      range(uint16Add(this.newEstSeqNum, 1), sequenceNumber).forEach((seq) => {
        this._lost[seq] = 1;
      });
      this.receiver.sendRtcpPLI(this.mediaSourceSsrc);

      this.newEstSeqNum = sequenceNumber;

      if (Object.keys(this._lost).length > LOST_SIZE) {
        this._lost = Object.entries(this._lost)
          .slice(-LOST_SIZE)
          .reduce((acc, [key, v]) => {
            acc[key] = v;
            return acc;
          }, {} as { [seqNum: number]: number });
      }
    }
  }

  close() {
    clearInterval(this.nackLoop);
  }

  private increment() {
    Object.keys(this._lost).forEach((seq) => {
      if (++this._lost[seq] > 10) {
        delete this._lost[seq];
      }
    });
  }

  private packetLost() {
    if (this.lost.length > 0 && this.mediaSourceSsrc) {
      const nack = new GenericNack({
        senderSsrc: this.receiver.rtcpSsrc,
        mediaSourceSsrc: this.mediaSourceSsrc,
        lost: this.lost,
      });
      const rtcp = new RtcpTransportLayerFeedback({
        feedback: nack,
      });
      this.receiver.dtlsTransport.sendRtcp([rtcp]);

      this.increment();
      this.onPacketLost.execute(nack);
    }
  }
}
