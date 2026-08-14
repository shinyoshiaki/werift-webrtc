[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedState

# Type Alias: LossBasedState

> **LossBasedState**: `"increasing"` \| `"increase_using_padding"` \| `"decreasing"` \| `"delay_based"`

Loss-based BWE states (libwebrtc `LossBasedState`).
There is no `kHold` — HOLD is a timer inside `kDecreasing`
(`last_hold_info_`). `increase_using_padding` is used when
[kLossBasedPaddingDurationMs](../variables/kLossBasedPaddingDurationMs.md) > 0 (pin PaddingDuration default 2s).
