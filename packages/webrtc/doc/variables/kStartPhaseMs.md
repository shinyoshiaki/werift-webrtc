[**werift**](../README.md)

***

[werift](../globals.md) / kStartPhaseMs

# Variable: kStartPhaseMs

> `const` **kStartPhaseMs**: `2000` = `2_000`

pin `SendSideBandwidthEstimation` `kStartPhase` = 2s.
Startup delay/REMB trust (`last_fraction_loss_ == 0`) lasts until this
window after the first [GccBandwidthEstimator.updatePacketsLost](../classes/GccBandwidthEstimator.md#updatepacketslost)
(RTCP TransportLossReport). With no RR, first_report_time stays infinite
and the start phase remains open until LossBasedV2 is ready.
