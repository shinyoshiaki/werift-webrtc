[**werift**](../README.md)

***

[werift](../globals.md) / TransportWideSeqUnwrapper

# Class: TransportWideSeqUnwrapper

pin `rtc_base/numerics/sequence_number_unwrapper.h` `SeqNumUnwrapper<uint16_t>`.

Transport-wide CC on the wire is 16-bit. History / probe maps must key by the
unwrapped (extended) sequence so a wrap does not overwrite the previous
generation still inside the send-time window.

Values `> 0xffff` are treated as already-unwrapped (tests / callers that
already advanced a generation, e.g. `wideSeq=65537`).

## Constructors

### Constructor

> **new TransportWideSeqUnwrapper**(): `TransportWideSeqUnwrapper`

#### Returns

`TransportWideSeqUnwrapper`

## Accessors

### last

#### Get Signature

> **get** **last**(): `number` \| `undefined`

Last extended sequence, or `undefined` before the first unwrap.

##### Returns

`number` \| `undefined`

## Methods

### advanceSent()

> **advanceSent**(`seq`): `number`

Map a **send-time** TSN onto a monotonic key.

Wire TSN only increases. A jump larger than half the 16-bit space is a
gap (other BUNDLE senders while this one was idle), not wrap-back.
[peek](#peek) still uses the half-modulus rule for 16-bit feedback.

#### Parameters

##### seq

`number`

#### Returns

`number`

***

### peek()

> **peek**(`seq`): `number`

Same mapping as [unwrap](#unwrap) without updating the origin.
Used when matching TWCC 16-bit feedback against already-sent history.

#### Parameters

##### seq

`number`

#### Returns

`number`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### unwrap()

> **unwrap**(`seq`): `number`

Map a 16-bit (or already-extended) sequence to a monotonic int and
remember it as the unwrap origin.

#### Parameters

##### seq

`number`

#### Returns

`number`
