[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpTimelineSwitch

# Interface: RtpTimelineSwitch

Notified when output continues from a previous source.

## Properties

### inputSsrc

> **inputSsrc**: `number`

Input SSRC of the new source.

***

### sequenceNumber

> **sequenceNumber**: `number`

Output sequence number of the first packet of the new source.

***

### source

> **source**: `unknown`

`source` key of the new source (undefined when keys are not used).

***

### timestamp

> **timestamp**: `number`

Output timestamp of the first packet of the new source.

***

### timestampStep

> **timestampStep**: `number`

Timestamp increment applied across the switch.
