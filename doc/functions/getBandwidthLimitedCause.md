[**werift**](../README.md)

***

[werift](../globals.md) / getBandwidthLimitedCause

# Function: getBandwidthLimitedCause()

> **getBandwidthLimitedCause**(`usage`, `isRttAboveLimit`, `lossState`): [`BandwidthLimitedCause`](../type-aliases/BandwidthLimitedCause.md)

libwebrtc `GetBandwidthLimitedCause` (goog_cc_network_control.cc).

| Delay usage | RTT high? | LossBasedState | Cause |
| overuse/underuse | * | * | delay_based_limited_delay_increased |
| normal | yes | * | rtt_based_back_off_high_rtt |
| normal | no | decreasing / hold / padding | loss_limited_bwe |
| normal | no | increasing | loss_limited_bwe_increasing |
| normal | no | delay_based | delay_based_limited |

Note: werift folds `kIncreaseUsingPadding` into `increasing` for rate
control, but keeps a separate `hold` state that still maps to the forbid
cause (`kLossLimitedBwe`) — same InitiateProbing outcome as pin.

## Parameters

### usage

[`BandwidthUsage`](../type-aliases/BandwidthUsage.md)

### isRttAboveLimit

`boolean`

### lossState

[`LossBasedState`](../type-aliases/LossBasedState.md)

## Returns

[`BandwidthLimitedCause`](../type-aliases/BandwidthLimitedCause.md)
