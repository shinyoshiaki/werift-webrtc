[**werift**](../README.md)

***

[werift](../globals.md) / TransactionRequestOptions

# Interface: TransactionRequestOptions

Options for a STUN transaction / Protocol.request.
Retransmission count and response wait deadline are independent
so consent freshness (retransmissions: 0, longer timeout) can be expressed.

## Properties

### failOnSendError?

> `optional` **failOnSendError?**: `boolean`

Fail the transaction as soon as the request cannot be sent instead of
waiting for the response timeout. Used on reliable transports (TCP),
where a send error means the connection itself is unusable.

***

### integrityAlgorithm?

> `optional` **integrityAlgorithm?**: [`MessageIntegrityMode`](../type-aliases/MessageIntegrityMode.md)

Integrity attributes a request signed with `integrityKey` carries.
Defaults to `"sha1"` (MESSAGE-INTEGRITY only). Responses are accepted
with either algorithm regardless of this choice. Ignored by the TURN
client's own long-term credential requests (TurnProtocol), which stay
MESSAGE-INTEGRITY only.

***

### integrityKey?

> `optional` **integrityKey?**: `Buffer`\<`ArrayBufferLike`\>

When set, responses must include MESSAGE-INTEGRITY or
MESSAGE-INTEGRITY-SHA256 and pass HMAC verification (protocol re-parses
the wire bytes with this key; the transaction also rejects unsigned
Messages as defense-in-depth). Unsigned or forged responses must not
complete the transaction.

***

### onRequestSent?

> `optional` **onRequestSent?**: (`attempt`) => `void`

Called for each wire send (attempt 0 is the initial transmission).

#### Parameters

##### attempt

`number`

#### Returns

`void`

***

### responseTimeout?

> `optional` **responseTimeout?**: `number`

Initial response wait deadline in milliseconds.
Doubled after each retransmission when retransmissions > 0.
Defaults to RETRY_RTO when omitted.

***

### retransmissions?

> `optional` **retransmissions?**: `number`

Number of retransmissions after the initial send. 0 = send once.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Abort the outstanding transaction (e.g. consent lifecycle teardown).
