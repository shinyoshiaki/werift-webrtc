import {
  kAlrBandwidthUsageRatio,
  kAlrStartBudgetLevelRatio,
  kAlrStopBudgetLevelRatio,
} from "./constants";
import { IntervalBudget } from "./intervalBudget";

/**
 * pin `modules/congestion_controller/goog_cc/alr_detector`.
 *
 * ALR starts when the send budget ratio exceeds
 * {@link kAlrStartBudgetLevelRatio} (underusing) and ends when it falls below
 * {@link kAlrStopBudgetLevelRatio}. Budget target is estimate ×
 * {@link kAlrBandwidthUsageRatio}.
 *
 * Start time uses the sender clock (`sendMs`), matching pin Timestamp domain.
 */
export class AlrDetector {
  private lastSendMs: number | undefined;
  private startedMs: number | undefined;
  private readonly budget = new IntervalBudget(true);

  reset() {
    this.lastSendMs = undefined;
    this.startedMs = undefined;
    this.budget.reset();
  }

  onBytesSent(bytes: number, sendMs: number) {
    if (!Number.isFinite(sendMs) || bytes < 0) return;
    if (this.lastSendMs === undefined) {
      this.lastSendMs = sendMs;
      return;
    }
    const deltaMs = sendMs - this.lastSendMs;
    this.lastSendMs = sendMs;
    this.budget.useBudget(bytes);
    this.budget.increaseBudget(deltaMs);
    const ratio = this.budget.budgetRatio();
    if (ratio > kAlrStartBudgetLevelRatio && this.startedMs === undefined) {
      this.startedMs = sendMs;
    } else if (
      ratio < kAlrStopBudgetLevelRatio &&
      this.startedMs !== undefined
    ) {
      this.startedMs = undefined;
    }
  }

  setEstimatedBitrate(bps: number) {
    if (!(bps > 0) || !Number.isFinite(bps)) return;
    this.budget.setTargetRateKbps((bps * kAlrBandwidthUsageRatio) / 1000);
  }

  get inAlr(): boolean {
    return this.startedMs !== undefined;
  }

  /** Sender-clock time when the current ALR region started, if any. */
  get startMs(): number | undefined {
    return this.startedMs;
  }
}
