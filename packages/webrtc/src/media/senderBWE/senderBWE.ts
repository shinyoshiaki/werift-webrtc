import Event from "rx.mini";
import { TransportWideCC } from "../../../../rtp/src";
import { milliTime } from "../../utils";
import { CumulativeResult } from "./cumulativeResult";

export class SenderBandwidthEstimator {
  availableBitrate = 1_000_000;
  congestion = false;
  readonly onAvailableBitrate = new Event<[number]>();
  readonly onCongestion = new Event<[boolean]>();

  private congestionCounter = 0;
  private congestionTimes = 0;
  private cumulativeResult = new CumulativeResult();
  private sentInfos: { [key: number]: SentInfo } = {};

  receiveTWCC(feedback: TransportWideCC) {
    const nowMs = milliTime();
    const elapsedMs = nowMs - this.cumulativeResult.firstPacketSentAtMs;
    if (elapsedMs > 1000) {
      this.cumulativeResult.reset();

      // Congestion may be occurring.

      this.congestionCounter =
        this.congestionCounter + this.congestionTimes + 1;

      if (this.congestionCounter > 10 && !this.congestion) {
        this.congestion = true;
        this.onCongestion.execute(this.congestion);
        this.congestionTimes++;
      }
    } else {
      if (this.congestionCounter > 0) this.congestionCounter--;
      if (this.congestionCounter === 0 && this.congestion) {
        this.congestion = false;
        this.onCongestion.execute(this.congestion);
      }
    }

    for (const result of feedback.packetResults) {
      if (!result.received) continue;

      const wideSeq = result.sequenceNumber;
      const info = this.sentInfos[wideSeq];
      if (!info) continue;

      this.cumulativeResult.addPacket(
        info.size,
        info.sendingAtMs,
        result.receivedAtMs
      );
    }

    if (elapsedMs >= 100 && this.cumulativeResult.numPackets >= 20) {
      this.estimateAvailableBitrate(this.cumulativeResult);
      this.cumulativeResult.reset();
    }
  }

  private estimateAvailableBitrate(cumulativeResult: CumulativeResult) {
    const previousAvailableBitrate = this.availableBitrate;

    const ratio =
      cumulativeResult.receiveBitrate / cumulativeResult.sendBitrate;
    const bitrate = Math.min(
      cumulativeResult.receiveBitrate,
      cumulativeResult.sendBitrate
    );
    console.log(
      "send",
      cumulativeResult.sendBitrate / 1000,
      cumulativeResult.receiveBitrate
    );
    if (0.75 <= ratio && ratio <= 1.25) {
      if (bitrate > this.availableBitrate) {
        this.availableBitrate = bitrate;
      }
    } else {
      if (bitrate < this.availableBitrate) {
        this.availableBitrate = bitrate;
      }
    }

    if (previousAvailableBitrate !== this.availableBitrate) {
      console.log(this.availableBitrate);
      this.onAvailableBitrate.execute(this.availableBitrate);
    }
  }

  rtpPacketSent(sentInfo: SentInfo) {
    // Object.keys(sentInfo)
    //   .map((v) => Number(v))
    //   .sort()
    //   .filter((seq) => seq < sentInfo.wideSeq)
    //   .forEach((seq) => {
    //     delete this.sentInfos[seq];
    //   });
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
