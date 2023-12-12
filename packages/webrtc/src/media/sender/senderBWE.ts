import Event from "rx.mini";

import { TransportWideCC } from "../../../../rtp/src";
import { Int } from "../../../../rtp/src/helper";
import { milliTime } from "../../utils";
import { CumulativeResult } from "./cumulativeResult";

const COUNTER_MAX = 20;
const SCORE_MAX = 10;

export class SenderBandwidthEstimator {
  congestion = false;

  readonly onAvailableBitrate = new Event<[number]>();
  /**congestion occur or not */
  readonly onCongestion = new Event<[boolean]>();
  readonly onCongestionScore = new Event<[number]>();

  private congestionCounter = 0;
  private cumulativeResult = new CumulativeResult();
  private sentInfos: { [key: number]: SentInfo } = {};
  private _congestionScore = 1;
  /**1~10 big is worth*/
  get congestionScore() {
    return this._congestionScore;
  }
  set congestionScore(v: number) {
    this._congestionScore = v;
    this.onCongestionScore.execute(v);
  }
  private _availableBitrate: number = 0;
  get availableBitrate() {
    return this._availableBitrate;
  }
  set availableBitrate(v: number) {
    this._availableBitrate = v;
    this.onAvailableBitrate.execute(v);
  }

  constructor() {}

  receiveTWCC(feedback: TransportWideCC) {
    const nowMs = milliTime();
    const elapsedMs = nowMs - this.cumulativeResult.firstPacketSentAtMs;
    if (elapsedMs > 1000) {
      this.cumulativeResult.reset();

      // Congestion may be occurring.

      if (this.congestionCounter < COUNTER_MAX) {
        this.congestionCounter++;
      } else if (this.congestionScore < SCORE_MAX) {
        this.congestionScore++;
      }

      if (this.congestionCounter >= COUNTER_MAX && !this.congestion) {
        this.congestion = true;
        this.onCongestion.execute(this.congestion);
      }
    }

    for (const result of feedback.packetResults) {
      if (!result.received) continue;

      const wideSeq = result.sequenceNumber;
      const info = this.sentInfos[wideSeq];
      if (!info) continue;
      if (!result.receivedAtMs) continue;

      this.cumulativeResult.addPacket(
        info.size,
        info.sendingAtMs,
        result.receivedAtMs,
      );
    }

    if (elapsedMs >= 100 && this.cumulativeResult.numPackets >= 20) {
      this.availableBitrate = Math.min(
        this.cumulativeResult.sendBitrate,
        this.cumulativeResult.receiveBitrate,
      );
      this.cumulativeResult.reset();

      if (this.congestionCounter > -COUNTER_MAX) {
        const maxBonus = Int(COUNTER_MAX / 2) + 1;
        const minBonus = Int(COUNTER_MAX / 4) + 1;
        const bonus =
          maxBonus - ((maxBonus - minBonus) / 10) * this.congestionScore;

        this.congestionCounter = this.congestionCounter - bonus;
      }

      if (this.congestionCounter <= -COUNTER_MAX) {
        if (this.congestionScore > 1) {
          this.congestionScore--;
          this.onCongestion.execute(false);
        }
        this.congestionCounter = 0;
      }

      if (this.congestionCounter <= 0 && this.congestion) {
        this.congestion = false;
        this.onCongestion.execute(this.congestion);
      }
    }
  }

  rtpPacketSent(sentInfo: SentInfo) {
    Object.keys(sentInfo)
      .map((v) => Number(v))
      .sort()
      .filter((seq) => seq < sentInfo.wideSeq)
      .forEach((seq) => {
        delete this.sentInfos[seq];
      });
    this.sentInfos[sentInfo.wideSeq] = sentInfo;
  }
}

export interface SentInfo {
  wideSeq: number;
  /**
   * byte
   */
  size: number;
  isProbation?: boolean;
  sendingAtMs: number;
  sentAtMs: number;
}
