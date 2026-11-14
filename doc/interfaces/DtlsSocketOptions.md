[**werift**](../README.md)

***

[werift](../globals.md) / DtlsSocketOptions

# Interface: DtlsSocketOptions

## Properties

### cert?

> `optional` **cert?**: `string`

***

### certificateRequest?

> `optional` **certificateRequest?**: `boolean`

***

### extendedMasterSecret?

> `optional` **extendedMasterSecret?**: `boolean`

***

### key?

> `optional` **key?**: `string`

***

### signatureHash?

> `optional` **signatureHash?**: [`SignatureHash`](../type-aliases/SignatureHash.md)

***

### srtpProfiles?

> `optional` **srtpProfiles?**: (`1` \| `7`)[]

***

### transport

> **transport**: [`Transport`](Transport.md)

***

### verifyRemoteCertificate?

> `optional` **verifyRemoteCertificate?**: (`certificate`) => `boolean`

Verify the peer certificate (DER) during the handshake. Returning false
or throwing aborts the handshake with a fatal bad_certificate alert, so
the peer learns the failure before it considers the connection
established: the client checks the server certificate before sending
flight 5, the server checks the client certificate before sending its
Finished. onError receives a [DtlsAlertError](../classes/DtlsAlertError.md) with
`source: "local"`.

#### Parameters

##### certificate

`Buffer`

#### Returns

`boolean`
