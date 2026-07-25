import { Event, uint16Gt } from "../../../imports/common";
import { Int, type TransportWideCC } from "../../../imports/rtp";
import { milliTime } from "../../../utils";
import type { BandwidthEstimator, SentInfo } from "../bandwidthEstimator";
import { setAvailableBitrateIfChanged } from "../bandwidthEstimator";
import { CumulativeResult } from "../cumulativeResult";

const COUNTER_MAX = 20;
const SCORE_MAX = 10;

/**
 * Legacy cumulative min(send, recv) bandwidth estimator (mediasoup-inspired).
 *
 * This is the **default** send-side BWE used by {@link RTCRtpSender}.
 * Implements {@link BandwidthEstimator}; congestion-related events are **legacy-only**
 * and are not part of the shared interface.
 *
 * @see CumulativeResult
 */
export class SenderBandwidthEstimator implements BandwidthEstimator {
  congestion = false;

  /**
   * Recommended available send bitrate in **bps**.
   * Notifies {@link onAvailableBitrate} only when the value changes.
   */
  /** @internal */
  _availableBitrate = 0;

  /**
   * Fires when recommended send bitrate (**bps**) changes.
   * @see BandwidthEstimator.onAvailableBitrate
   */
  readonly onAvailableBitrate = new Event<[number]>();

  /** Legacy-only: whether congestion is considered active. */
  readonly onCongestion = new Event<[boolean]>();
  /** Legacy-only: congestion score 1–10 (higher is worse). */
  readonly onCongestionScore = new Event<[number]>();

  private congestionCounter = 0;
  private cumulativeResult = new CumulativeResult();
  private sentInfos: { [key: number]: SentInfo } = {};
  private _congestionScore = 1;

  /** 1–10; larger means worse congestion (legacy-specific). */
  get congestionScore() {
    return this._congestionScore;
  }
  set congestionScore(v: number) {
    this._congestionScore = v;
    this.onCongestionScore.execute(v);
  }

  get availableBitrate() {
    return this._availableBitrate;
  }
  set availableBitrate(v: number) {
    setAvailableBitrateIfChanged(this, v);
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
    const latest = sentInfo.wideSeq & 0xffff;
    // Drop history older than the latest wide seq (16-bit wrap-aware).
    for (const key of Object.keys(this.sentInfos)) {
      const seq = Number(key) & 0xffff;
      if (seq !== latest && !uint16Gt(seq, latest)) {
        delete this.sentInfos[seq];
      }
    }
    this.sentInfos[latest] = sentInfo;
  }

  reset() {
    this.congestion = false;
    this.congestionCounter = 0;
    this._congestionScore = 1;
    this._availableBitrate = 0;
    this.cumulativeResult.reset();
    this.sentInfos = {};
  }

  dispose() {
    this.onAvailableBitrate.allUnsubscribe();
    this.onCongestion.allUnsubscribe();
    this.onCongestionScore.allUnsubscribe();
    this.reset();
  }
}

/** Alias emphasizing the cumulative min-bitrate nature of the legacy algorithm. */
export { SenderBandwidthEstimator as LegacyCumulativeBandwidthEstimator };
