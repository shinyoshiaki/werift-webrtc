[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / TransactionRequestOptions

# Interface: TransactionRequestOptions

Options for a STUN transaction / Protocol.request.
Retransmission count and response wait deadline are independent
so consent freshness (retransmissions: 0, longer timeout) can be expressed.

## Properties

### integrityKey?

> `optional` **integrityKey**: `Buffer`\<`ArrayBufferLike`\>

When set, responses must include MESSAGE-INTEGRITY and pass HMAC
verification (protocol re-parses the wire bytes with this key; the
transaction also rejects unsigned Messages as defense-in-depth).
Unsigned or forged responses must not complete the transaction.

***

### onRequestSent()?

> `optional` **onRequestSent**: (`attempt`) => `void`

Called for each wire send (attempt 0 is the initial transmission).

#### Parameters

##### attempt

`number`

#### Returns

`void`

***

### responseTimeout?

> `optional` **responseTimeout**: `number`

Initial response wait deadline in milliseconds.
Doubled after each retransmission when retransmissions > 0.
Defaults to RETRY_RTO when omitted.

***

### retransmissions?

> `optional` **retransmissions**: `number`

Number of retransmissions after the initial send. 0 = send once.

***

### signal?

> `optional` **signal**: `AbortSignal`

Abort the outstanding transaction (e.g. consent lifecycle teardown).
