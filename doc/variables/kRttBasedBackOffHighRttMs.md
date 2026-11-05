[**werift**](../README.md)

***

[werift](../globals.md) / kRttBasedBackOffHighRttMs

# Variable: kRttBasedBackOffHighRttMs

> `const` **kRttBasedBackOffHighRttMs**: `3000` = `3_000`

RTT threshold for RttBasedBackoff::IsRttAboveLimit (pin
send_side_bandwidth_estimation + goog_cc_network_control):
when CorrectedRtt (timeout_correction + **propagation** RTT) exceeds this,
GetBandwidthLimitedCause becomes kRttBasedBackOffHighRtt and
ProbeController::InitiateProbing returns no clusters.
Default 3s = WebRTC-Bwe-MaxRttLimit field-trial default (`limit`).
Raw max_feedback_rtt is **not** used for probe cause (CWND only in pin).
SendSideBandwidthEstimation::UpdateEstimate also multiplies the target by
[kRttBasedBackOffDropFraction](kRttBasedBackOffDropFraction.md) every [kRttBasedBackOffDropIntervalMs](kRttBasedBackOffDropIntervalMs.md)
down to [kRttBasedBackOffBandwidthFloorBps](kRttBasedBackOffBandwidthFloorBps.md).
