/*!
 * Portions of this file are ported from libwebrtc
 * (https://webrtc.googlesource.com/src, commit 0fda16159e33adf59c71a7ad1173dcbe5a632102).
 * Copyright (c) 2011, The WebRTC project authors. All rights reserved.
 * Use of that source is governed by a BSD-style license and an additional
 * patent grant; both are reproduced in THIRD_PARTY_LICENSES_LIBWEBRTC.txt
 * (shipped with this package).
 */
/**
 * pin `modules/pacing/interval_budget` — byte budget used by AlrDetector.
 *
 * Window is 500ms of the target rate. `canBuildUpUnderuse` (true for ALR)
 * lets unused budget accumulate up to that cap.
 */
export class IntervalBudget {
  private targetRateKbps = 0;
  private bytesRemaining = 0;

  constructor(private readonly canBuildUpUnderuse = true) {}

  reset() {
    this.targetRateKbps = 0;
    this.bytesRemaining = 0;
  }

  setTargetRateKbps(kbps: number) {
    this.targetRateKbps = Math.max(0, kbps);
  }

  increaseBudget(deltaMs: number) {
    const bytes = (this.targetRateKbps * Math.max(0, deltaMs)) / 8;
    const max = this.maxBytes();
    if (this.canBuildUpUnderuse || this.bytesRemaining < 0) {
      this.bytesRemaining = Math.min(this.bytesRemaining + bytes, max);
    } else {
      this.bytesRemaining = Math.min(bytes, max);
    }
  }

  useBudget(bytes: number) {
    this.bytesRemaining = Math.max(
      this.bytesRemaining - Math.max(0, bytes),
      -this.maxBytes(),
    );
  }

  budgetRatio(): number {
    const max = this.maxBytes();
    if (max <= 0) return 0;
    return this.bytesRemaining / max;
  }

  private maxBytes(): number {
    // pin IntervalBudget: 500ms of target rate.
    return (this.targetRateKbps * 500) / 8;
  }
}
