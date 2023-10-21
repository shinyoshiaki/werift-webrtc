import debug from "debug";
import range from "lodash/range";
import Event from "rx.mini";

import { uint16Add } from "../../../../common/src";
import {
  GenericNack,
  RtcpTransportLayerFeedback,
  RtpPacket,
} from "../../../../rtp/src";
import { RTCRtpReceiver } from "../rtpReceiver";

const log = debug("werift:packages/webrtc/src/media/receiver/nack.ts");

const LOST_SIZE = 30 * 5;

export class NackHandler {
  private newEstSeqNum = 0;
  private _lost: { [seqNum: number]: number } = {};
  private nackLoop: any;

  readonly onPacketLost = new Event<[GenericNack]>();
  mediaSourceSsrc?: number;
  retryCount = 10;
  closed = false;

  constructor(private receiver: RTCRtpReceiver) {}

  get lostSeqNumbers() {
    return Object.keys(this._lost).map(Number).sort();
  }

  private getLost(seq: number) {
    return this._lost[seq];
  }

  private setLost(seq: number, count: number) {
    this._lost[seq] = count;

    if (this.nackLoop || this.closed) {
      return;
    }
    this.nackLoop = setInterval(async () => {
      try {
        await this.sendNack();
        if (!Object.keys(this._lost).length) {
          clearInterval(this.nackLoop);
          this.nackLoop = undefined;
        }
      } catch (error) {
        log("failed to send nack", error);
      }
    }, 5);
  }

  private removeLost(sequenceNumber: number) {
    delete this._lost[sequenceNumber];
  }

  addPacket(packet: RtpPacket) {
    const { sequenceNumber, ssrc } = packet.header;
    this.mediaSourceSsrc = ssrc;

    if (this.newEstSeqNum === 0) {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    if (this.getLost(sequenceNumber)) {
      // log("packetLoss resolved", { sequenceNumber });
      this.removeLost(sequenceNumber);
      return;
    }

    if (sequenceNumber === uint16Add(this.newEstSeqNum, 1)) {
      this.newEstSeqNum = sequenceNumber;
    } else if (sequenceNumber > uint16Add(this.newEstSeqNum, 1)) {
      // packet lost detected
      range(uint16Add(this.newEstSeqNum, 1), sequenceNumber).forEach((seq) => {
        this.setLost(seq, 1);
      });
      // this.receiver.sendRtcpPLI(this.mediaSourceSsrc);

      this.newEstSeqNum = sequenceNumber;
      this.pruneLost();
    }
  }

  private pruneLost() {
    if (this.lostSeqNumbers.length > LOST_SIZE) {
      this._lost = Object.entries(this._lost)
        .slice(-LOST_SIZE)
        .reduce((acc, [key, v]) => {
          acc[key] = v;
          return acc;
        }, {} as { [seqNum: number]: number });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.nackLoop);
    this._lost = {};
  }

  private updateRetryCount() {
    this.lostSeqNumbers.forEach((seq) => {
      const count = this._lost[seq]++;
      if (count > this.retryCount) {
        this.removeLost(seq);
        return seq;
      }
    });
  }

  private sendNack = () =>
    new Promise((r, f) => {
      if (this.lostSeqNumbers.length > 0 && this.mediaSourceSsrc) {
        const nack = new GenericNack({
          senderSsrc: this.receiver.rtcpSsrc,
          mediaSourceSsrc: this.mediaSourceSsrc,
          lost: this.lostSeqNumbers,
        });

        const rtcp = new RtcpTransportLayerFeedback({
          feedback: nack,
        });
        this.receiver.dtlsTransport.sendRtcp([rtcp]).then(r).catch(f);

        this.updateRetryCount();
        this.onPacketLost.execute(nack);
      }
    });
}
