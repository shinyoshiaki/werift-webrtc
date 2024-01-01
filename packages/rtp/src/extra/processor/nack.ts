import debug from "debug";
import Event from "rx.mini";

import {
  GenericNack,
  RtcpTransportLayerFeedback,
  RtpPacket,
  timer,
  uint16Add,
} from "../..";
import { Processor } from "./interface";
import { RtpOutput } from "./rtpCallback";

const log = debug("werift-rtp : packages/rtp/src/processor/nack.ts");

const LOST_SIZE = 30 * 5;

export type NackHandlerInput = RtpOutput;

export type NackHandlerOutput = RtpOutput;

export class NackHandlerBase
  implements Processor<NackHandlerInput, NackHandlerOutput>
{
  private newEstSeqNum = 0;
  private _lost: { [seqNum: number]: number } = {};
  private clearNackInterval?: () => void;
  private internalStats = {};

  readonly onNackSent = new Event<[GenericNack]>();
  readonly onPacketLost = new Event<[number]>();
  mediaSourceSsrc?: number;
  readonly retryCount = 10;
  stopped = false;

  constructor(
    private senderSsrc: number,
    private onNack: (rtcp: RtcpTransportLayerFeedback) => Promise<void>,
  ) {}

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
      newEstSeqNum: this.newEstSeqNum,
      lostLength: Object.values(this._lost).length,
      senderSsrc: this.senderSsrc,
      mediaSourceSsrc: this.mediaSourceSsrc,
    };
  }

  private get lostSeqNumbers() {
    return Object.keys(this._lost).map(Number).sort();
  }

  private getLost(seq: number) {
    return this._lost[seq];
  }

  private setLost(seq: number, count: number) {
    this._lost[seq] = count;

    if (this.clearNackInterval || this.stopped) {
      return;
    }
    this.clearNackInterval = timer.setInterval(async () => {
      try {
        await this.sendNack();
        if (!Object.keys(this._lost).length) {
          this.clearNackInterval?.();
          this.clearNackInterval = undefined;
        }
      } catch (error) {
        log("failed to send nack", error);
      }
    }, 5);
  }

  private removeLost(sequenceNumber: number) {
    delete this._lost[sequenceNumber];
  }

  processInput = (input: RtpOutput) => {
    if (input.rtp) {
      this.addPacket(input.rtp);
      this.internalStats["nackHandler"] = new Date().toISOString();
      return [input];
    }

    this.stop();
    return [input];
  };

  private addPacket(packet: RtpPacket) {
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
      for (
        let seq = uint16Add(this.newEstSeqNum, 1);
        seq < sequenceNumber;
        seq++
      ) {
        this.setLost(seq, 1);
      }
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

  private stop() {
    this.stopped = true;
    this._lost = {};
    this.clearNackInterval?.();
    this.onNackSent.allUnsubscribe();
    this.onPacketLost.allUnsubscribe();
    this.onNack = undefined as any;
  }

  private updateRetryCount() {
    this.lostSeqNumbers.forEach((seq) => {
      const count = this._lost[seq]++;
      if (count > this.retryCount) {
        this.removeLost(seq);
        this.onPacketLost.execute(seq);
      }
    });
  }

  private sendNack = () =>
    new Promise((r, f) => {
      if (this.lostSeqNumbers.length > 0 && this.mediaSourceSsrc) {
        this.internalStats["count"] = (this.internalStats["count"] ?? 0) + 1;

        const nack = new GenericNack({
          senderSsrc: this.senderSsrc,
          mediaSourceSsrc: this.mediaSourceSsrc,
          lost: this.lostSeqNumbers,
        });

        const rtcp = new RtcpTransportLayerFeedback({
          feedback: nack,
        });
        this.onNack(rtcp).then(r).catch(f);

        this.updateRetryCount();
        this.onNackSent.execute(nack);
      }
    });
}
