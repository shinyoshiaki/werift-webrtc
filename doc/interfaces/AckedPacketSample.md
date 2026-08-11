[**werift**](../README.md)

***

[werift](../globals.md) / AckedPacketSample

# Interface: AckedPacketSample

One ACKed packet sample (TWCC receive timeline + sender send time).

## Properties

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
