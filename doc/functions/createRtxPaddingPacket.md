[**werift**](../README.md)

***

[werift](../globals.md) / createRtxPaddingPacket

# Function: createRtxPaddingPacket()

> **createRtxPaddingPacket**(`__namedParameters`): [`RtpPacket`](../classes/RtpPacket.md)

Padding-only RTP on the **RTX** SSRC / payload type (pin libwebrtc
`GeneratePadding` with RTX). The sequence is assigned at send time.

## Parameters

### \_\_namedParameters

#### paddingSize

`number`

#### payloadType

`number`

#### ssrc

`number`

#### timestamp

`number`

## Returns

[`RtpPacket`](../classes/RtpPacket.md)
