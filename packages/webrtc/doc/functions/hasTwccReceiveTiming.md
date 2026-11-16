[**werift**](../README.md)

***

[werift](../globals.md) / hasTwccReceiveTiming

# Function: hasTwccReceiveTiming()

> **hasTwccReceiveTiming**(`result`): `boolean`

Whether a TWCC [PacketResult](../classes/PacketResult.md) carries a usable receive-time sample
for delay-based BWE / acked bitrate.

- `TypeTCCPacketReceivedWithoutDelta`: received for loss accounting only —
  no timing (do not confuse with `receivedAtMs === 0`).
- Small/Large delta: `receivedAtMs` is valid **including 0** (reference_time
  base may be zero in fixtures / early feedback).
- Synthetic test results may set `received` + `receivedAtMs` without status;
  treat a finite `receivedAtMs` as a timing sample in that case.

## Parameters

### result

[`PacketResult`](../classes/PacketResult.md)

## Returns

`boolean`
