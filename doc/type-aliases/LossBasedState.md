[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedState

# Type Alias: LossBasedState

> **LossBasedState**: `"increasing"` \| `"increase_using_padding"` \| `"decreasing"` \| `"delay_based"` \| `"hold"`

Loss-based BWE states (libwebrtc LossBasedBweV2 naming).
`increase_using_padding` is used when [kLossBasedPaddingDurationMs](../variables/kLossBasedPaddingDurationMs.md) > 0
(pin PaddingDuration FieldTrial default 2s).
