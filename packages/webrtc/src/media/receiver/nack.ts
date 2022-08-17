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
  lost: { [seqNum: number]: number } = {};
  private nackLoop = setInterval(() => this.sendNack(), 20);

  readonly onPacketLost = new Event<[GenericNack]>();
  mediaSourceSsrc?: number;
  retryCount = 10;

  constructor(private receiver: RTCRtpReceiver) {}

  get lostNumber() {
    return Object.keys(this.lost).map(Number);
  }

  removeLost(sequenceNumber: number) {
    delete this.lost[sequenceNumber];
  }

  addPacket(packet: RtpPacket) {
    const { sequenceNumber, ssrc } = packet.header;
    this.mediaSourceSsrc = ssrc;

    if (this.newEstSeqNum === 0) {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    if (this.lost[sequenceNumber]) {
      this.removeLost(sequenceNumber);
      return;
    }

    if (sequenceNumber === uint16Add(this.newEstSeqNum, 1)) {
      this.newEstSeqNum = sequenceNumber;
    } else if (sequenceNumber > uint16Add(this.newEstSeqNum, 1)) {
      // packet lost detected
      range(uint16Add(this.newEstSeqNum, 1), sequenceNumber).forEach((seq) => {
        this.lost[seq] = 1;
      });
      this.receiver.sendRtcpPLI(this.mediaSourceSsrc);

      this.newEstSeqNum = sequenceNumber;
      this.pruneLost();
    }
  }

  private pruneLost() {
    if (Object.keys(this.lost).length > LOST_SIZE) {
      this.lost = Object.entries(this.lost)
        .slice(-LOST_SIZE)
        .reduce((acc, [key, v]) => {
          acc[key] = v;
          return acc;
        }, {} as { [seqNum: number]: number });
    }
  }

  close() {
    clearInterval(this.nackLoop);
    this.lost = {};
  }

  private updateRetryCount() {
    const res = Object.keys(this.lost)
      .map((seq) => {
        const count = this.lost[seq]++;
        if (count > this.retryCount) {
          delete this.lost[seq];
          return seq;
        }
      })
      .filter((v) => v != undefined);
    if (res.length > 0) {
      // log("failed to retransmit", res);
    }
  }

  private sendNack() {
    if (this.lostNumber.length > 0 && this.mediaSourceSsrc) {
      const nack = new GenericNack({
        senderSsrc: this.receiver.rtcpSsrc,
        mediaSourceSsrc: this.mediaSourceSsrc,
        lost: this.lostNumber,
      });
      const rtcp = new RtcpTransportLayerFeedback({
        feedback: nack,
      });
      this.receiver.dtlsTransport.sendRtcp([rtcp]);

      this.updateRetryCount();
      this.onPacketLost.execute(nack);
    }
  }
}
