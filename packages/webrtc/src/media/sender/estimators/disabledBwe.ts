import { Event } from "../../../imports/common";
import type { TransportWideCC } from "../../../imports/rtp";
import type { BandwidthEstimator, SentInfo } from "../bandwidthEstimator";
import { BandwidthEstimatorNoopHooks } from "../bandwidthEstimator";

/**
 * Send-side BWE that ignores TWCC and never recommends a bitrate.
 *
 * Used when {@link PeerConfig.bandwidthEstimator} is `false` / `"none"`.
 * Probe, pacing, RTT, and process-interval hooks are no-ops.
 */
export class DisabledBandwidthEstimator
  extends BandwidthEstimatorNoopHooks
  implements BandwidthEstimator
{
  /** @internal */
  _availableBitrate = 0;

  readonly onAvailableBitrate = new Event<[number]>();

  get availableBitrate() {
    return 0;
  }

  rtpPacketSent(_info: SentInfo): void {}

  receiveTWCC(_feedback: TransportWideCC): void {}

  reset(): void {
    this._availableBitrate = 0;
  }

  dispose(): void {
    this.onAvailableBitrate.allUnsubscribe();
    this.disposeNoopHooks();
    this.reset();
  }
}
