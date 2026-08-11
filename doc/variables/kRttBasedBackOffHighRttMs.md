[**werift**](../README.md)

***

[werift](../globals.md) / kRttBasedBackOffHighRttMs

# Variable: kRttBasedBackOffHighRttMs

> `const` **kRttBasedBackOffHighRttMs**: `3000` = `3_000`

libwebrtc RttBasedBackoff `configured_limit_` default (WebRTC-Bwe-MaxRttLimit
field trial, default 3s). CorrectedRtt > this → IsRttAboveLimit →
kRttBasedBackOffHighRtt → no new probes + periodic target drop.
