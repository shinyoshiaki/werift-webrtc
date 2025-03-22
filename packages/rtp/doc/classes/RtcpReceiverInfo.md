[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / RtcpReceiverInfo

# Class: RtcpReceiverInfo

## Constructors

### new RtcpReceiverInfo()

> **new RtcpReceiverInfo**(`props`): [`RtcpReceiverInfo`](RtcpReceiverInfo.md)

#### Parameters

• **props**: `Partial`\<[`RtcpReceiverInfo`](RtcpReceiverInfo.md)\> = `{}`

#### Returns

[`RtcpReceiverInfo`](RtcpReceiverInfo.md)

## Properties

### dlsr

> **dlsr**: `number`

delay since last SR

***

### fractionLost

> **fractionLost**: `number`

***

### highestSequence

> **highestSequence**: `number`

***

### jitter

> **jitter**: `number`

***

### lsr

> **lsr**: `number`

last SR

***

### packetsLost

> **packetsLost**: `number`

***

### ssrc

> **ssrc**: `number`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### dlsr

> **dlsr**: `number`

##### fractionLost

> **fractionLost**: `number`

##### highestSequence

> **highestSequence**: `number`

##### jitter

> **jitter**: `number`

##### lsr

> **lsr**: `number`

##### packetsLost

> **packetsLost**: `number`

##### ssrc

> **ssrc**: `number`

***

### deSerialize()

> `static` **deSerialize**(`data`): [`RtcpReceiverInfo`](RtcpReceiverInfo.md)

#### Parameters

• **data**: `Buffer`

#### Returns

[`RtcpReceiverInfo`](RtcpReceiverInfo.md)
