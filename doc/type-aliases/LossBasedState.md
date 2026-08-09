[**werift**](../README.md)

***

[werift](../globals.md) / LossBasedState

# Type Alias: LossBasedState

> **LossBasedState**: `"increasing"` \| `"decreasing"` \| `"delay_based"` \| `"hold"`

Loss-based BWE states (libwebrtc LossBasedBweV2 naming).
`increase_using_padding` is folded into `increasing` (no separate padding
duration controller on this lightweight pacer path).
