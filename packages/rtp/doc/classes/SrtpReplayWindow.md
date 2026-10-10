[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / SrtpReplayWindow

# Class: SrtpReplayWindow

RFC 3711 §3.3.2 receiver replay list: a sliding window over the packet
index (SRTP: ROC * 2^16 + SEQ, SRTCP: the 31-bit SRTCP index).

`check()` runs before the packet is accepted and `accept()` only after it
authenticated, so a forged packet cannot advance or poison the window.

## Constructors

### new SrtpReplayWindow()

> **new SrtpReplayWindow**(`size`): [`SrtpReplayWindow`](SrtpReplayWindow.md)

#### Parameters

##### size

`number` = `64`

#### Returns

[`SrtpReplayWindow`](SrtpReplayWindow.md)

## Properties

### size

> `readonly` **size**: `number` = `64`

## Methods

### accept()

> **accept**(`index`): `void`

Record an authenticated `index`.

#### Parameters

##### index

`number`

#### Returns

`void`

***

### check()

> **check**(`index`): `boolean`

True when `index` is neither a replay nor older than the window.

#### Parameters

##### index

`number`

#### Returns

`boolean`
