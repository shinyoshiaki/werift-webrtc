[**werift**](../README.md)

***

[werift](../globals.md) / DirectHandshakeCarrier

# Class: DirectHandshakeCarrier

Direct datagram carrier wrapping existing Transport (UDP etc.).
Epic 1 uses internal retransmission; external mode only stops timers (SPED skeleton).

## Implements

- [`DtlsHandshakeCarrier`](../interfaces/DtlsHandshakeCarrier.md)

## Constructors

### new DirectHandshakeCarrier()

> **new DirectHandshakeCarrier**(`transport`, `options`?): [`DirectHandshakeCarrier`](DirectHandshakeCarrier.md)

#### Parameters

##### transport

[`Transport`](../interfaces/Transport.md)

##### options?

###### mtu?

`number`

###### onInject?

(`bytes`, `peer`?) => `void`

#### Returns

[`DirectHandshakeCarrier`](DirectHandshakeCarrier.md)

## Properties

### events

> `readonly` **events**: `CarrierEvents` = `{}`

## Methods

### cancelAllTimers()

> **cancelAllTimers**(): `void`

Cancel all pending timers (close / error / handshake complete).

#### Returns

`void`

***

### close()

> **close**(): `void`

#### Returns

`void`

***

### getMtu()

> **getMtu**(): `number`

#### Returns

`number`

#### Implementation of

[`DtlsHandshakeCarrier`](../interfaces/DtlsHandshakeCarrier.md).[`getMtu`](../interfaces/DtlsHandshakeCarrier.md#getmtu)

***

### getRetransmissionMode()

> **getRetransmissionMode**(): [`RetransmissionMode`](../type-aliases/RetransmissionMode.md)

#### Returns

[`RetransmissionMode`](../type-aliases/RetransmissionMode.md)

***

### getRtt()

> **getRtt**(): `number`

#### Returns

`number`

***

### inject()

> **inject**(`bytes`, `peer`?): `void`

Inject a received datagram into the DTLS engine (used by SPED / dual-engine reinject).
Optional peer preserves source address for cookie address-validation binding.

#### Parameters

##### bytes

`Buffer`

##### peer?

`InjectPeerAddr`

#### Returns

`void`

#### Implementation of

[`DtlsHandshakeCarrier`](../interfaces/DtlsHandshakeCarrier.md).[`inject`](../interfaces/DtlsHandshakeCarrier.md#inject)

***

### isClosed()

> **isClosed**(): `boolean`

#### Returns

`boolean`

***

### schedule()

> **schedule**(`ms`, `fn`): () => `void`

Schedule a cancelable timer (internal retransmission).

#### Parameters

##### ms

`number`

##### fn

() => `void`

#### Returns

`Function`

##### Returns

`void`

***

### send()

> **send**(`packet`): `Promise`\<`void`\>

#### Parameters

##### packet

[`DtlsHandshakeDatagram`](../interfaces/DtlsHandshakeDatagram.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`DtlsHandshakeCarrier`](../interfaces/DtlsHandshakeCarrier.md).[`send`](../interfaces/DtlsHandshakeCarrier.md#send)

***

### setInjectHandler()

> **setInjectHandler**(`handler`): `void`

#### Parameters

##### handler

(`bytes`, `peer`?) => `void`

#### Returns

`void`

***

### setMtu()

> **setMtu**(`mtu`): `void`

#### Parameters

##### mtu

`number`

#### Returns

`void`

***

### setRetransmissionMode()

> **setRetransmissionMode**(`mode`): `void`

#### Parameters

##### mode

[`RetransmissionMode`](../type-aliases/RetransmissionMode.md)

#### Returns

`void`

#### Implementation of

[`DtlsHandshakeCarrier`](../interfaces/DtlsHandshakeCarrier.md).[`setRetransmissionMode`](../interfaces/DtlsHandshakeCarrier.md#setretransmissionmode)

***

### updateRtt()

> **updateRtt**(`rttMs`): `void`

#### Parameters

##### rttMs

`number`

#### Returns

`void`

#### Implementation of

[`DtlsHandshakeCarrier`](../interfaces/DtlsHandshakeCarrier.md).[`updateRtt`](../interfaces/DtlsHandshakeCarrier.md#updatertt)
