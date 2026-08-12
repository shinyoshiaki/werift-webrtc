[**werift**](../README.md)

***

[werift](../globals.md) / isRttAboveLimit

# Function: isRttAboveLimit()

> **isRttAboveLimit**(`rttMs`, `limitMs`): `boolean`

RTT above libwebrtc RttBasedBackoff default limit (3s).
Call with **CorrectedRtt / propagation RTT** (not raw max feedback RTT).
Prefer [RttBasedBackoff.isRttAboveLimit](../classes/RttBasedBackoff.md#isrttabovelimit) when the helper is available.

## Parameters

### rttMs

`number`

### limitMs

`number` = `kRttBasedBackOffHighRttMs`

## Returns

`boolean`
