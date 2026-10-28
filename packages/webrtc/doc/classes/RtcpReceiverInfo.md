[**werift**](../README.md)

***

[werift](../globals.md) / RtcpReceiverInfo

# Class: RtcpReceiverInfo

## Constructors

### Constructor

> **new RtcpReceiverInfo**(`props?`): `RtcpReceiverInfo`

#### Parameters

##### props?

`Partial`\<`RtcpReceiverInfo`\> = `{}`

#### Returns

`RtcpReceiverInfo`

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

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

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

> `static` **deSerialize**(`data`): `RtcpReceiverInfo`

#### Parameters

##### data

`Buffer`

#### Returns

`RtcpReceiverInfo`
