[**werift**](../README.md)

***

[werift](../globals.md) / DtlsHandshakeCarrier

# Interface: DtlsHandshakeCarrier

## Methods

### getMtu()

> **getMtu**(): `number`

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

***

### send()

> **send**(`packet`): `Promise`\<`void`\>

#### Parameters

##### packet

[`DtlsHandshakeDatagram`](DtlsHandshakeDatagram.md)

#### Returns

`Promise`\<`void`\>

***

### setRetransmissionMode()

> **setRetransmissionMode**(`mode`): `void`

#### Parameters

##### mode

[`RetransmissionMode`](../type-aliases/RetransmissionMode.md)

#### Returns

`void`

***

### updateRtt()

> **updateRtt**(`rttMs`): `void`

#### Parameters

##### rttMs

`number`

#### Returns

`void`
