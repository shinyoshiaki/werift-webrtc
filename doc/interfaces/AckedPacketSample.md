[**werift**](../README.md)

***

[werift](../globals.md) / AckedPacketSample

# Interface: AckedPacketSample

One ACKed packet sample (TWCC receive timeline + sender send time).

## Properties

### priorUnackedBytes?

> `optional` **priorUnackedBytes**: `number`

pin `SentPacket.prior_unacked_data` — added to both send and receive
size (RobustThroughputEstimator).

***

### receiveTimeMs

> **receiveTimeMs**: `number`

TWCC-relative receive time (ms).

***

### sendTimeMs

> **sendTimeMs**: `number`

Sender send time (ms), same clock as SentInfo.sendingAtMs.

***

### sizeBytes

> **sizeBytes**: `number`

Packet size in bytes (payload + headers counted by BWE).
