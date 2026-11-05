[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpContinuity

# Class: RtpContinuity

Output sequence number / timestamp of one sender's media stream.

Output = input + offset. The offsets change only at a scheduled source
switch (`replaceTrack`, `onSourceChanged`): the first packet actually sent
after it continues from the last output (`seq + 1`, `timestamp + step`).
RTX and padding use their own numbering and never go through this.

## Constructors

### Constructor

> **new RtpContinuity**(): `RtpContinuity`

#### Returns

`RtpContinuity`

## Accessors

### sequenceNumber

#### Get Signature

> **get** **sequenceNumber**(): `number` \| `undefined`

Last sent output sequence number; undefined before the first packet.

##### Returns

`number` \| `undefined`

***

### timestamp

#### Get Signature

> **get** **timestamp**(): `number` \| `undefined`

Last sent output timestamp; undefined before the first packet.

##### Returns

`number` \| `undefined`

## Methods

### assign()

> **assign**(`header`, `inputSequenceNumber`, `inputTimestamp`): `boolean`

Assign the output sequence number / timestamp of a media packet that is
about to be written, applying a scheduled rewrite first.

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

##### inputSequenceNumber

`number`

##### inputTimestamp

`number`

#### Returns

`boolean`

true when a rewrite moved the offsets (a new RTP clock origin).

***

### cancel()

> **cancel**(): `void`

Forget a scheduled rewrite (track detached / sender stopped).

#### Returns

`void`

***

### mapTimestamp()

> **mapTimestamp**(`inputTimestamp`): `number`

Output timestamp of `inputTimestamp` with the current offset (before send).

#### Parameters

##### inputTimestamp

`number`

#### Returns

`number`

***

### schedule()

> **schedule**(`timestampStep?`): `void`

Rewrite offsets on the next sent packet.

#### Parameters

##### timestampStep?

`number` = `1`

Timestamp increment across the source boundary.

#### Returns

`void`
