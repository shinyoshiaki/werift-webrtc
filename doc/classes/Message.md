[**werift**](../README.md)

***

[werift](../globals.md) / Message

# Class: Message

## Extends

- `AttributeRepository`

## Constructors

### Constructor

> **new Message**(`messageMethod`, `messageClass`, `transactionId?`, `attributes?`, `rawAttributes?`, `alternateServers?`): `Message`

#### Parameters

##### messageMethod

[`methods`](../enumerations/methods.md)

##### messageClass

[`classes`](../enumerations/classes.md)

##### transactionId?

`Buffer` = `...`

##### attributes?

`AttributePair`[] = `[]`

##### rawAttributes?

`RawAttribute`[] = `[]`

##### alternateServers?

\[`string`, `number`\][] = `[]`

#### Returns

`Message`

#### Overrides

`AttributeRepository.constructor`

## Properties

### alternateServers

> **alternateServers**: \[`string`, `number`\][]

Every ALTERNATE-SERVER attribute, in wire order.

***

### attributes

> `protected` **attributes**: `AttributePair`[]

#### Inherited from

`AttributeRepository.attributes`

***

### messageClass

> **messageClass**: [`classes`](../enumerations/classes.md)

***

### messageMethod

> **messageMethod**: [`methods`](../enumerations/methods.md)

***

### rawAttributes

> **rawAttributes**: `RawAttribute`[]

***

### transactionId

> **transactionId**: `Buffer`

## Accessors

### attributesKeys

#### Get Signature

> **get** **attributesKeys**(): (`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"MESSAGE-INTEGRITY-SHA256"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"USERHASH"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"UNKNOWN-ATTRIBUTES"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"REQUESTED-ADDRESS-FAMILY"` \| `"EVEN-PORT"` \| `"PASSWORD-ALGORITHM"` \| `"PASSWORD-ALGORITHMS"` \| `"XOR-RELAYED-ADDRESS"` \| `"RESERVATION-TOKEN"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"ALTERNATE-DOMAIN"` \| `"ALTERNATE-SERVER"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`)[]

##### Returns

(`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"MESSAGE-INTEGRITY-SHA256"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"USERHASH"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"UNKNOWN-ATTRIBUTES"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"REQUESTED-ADDRESS-FAMILY"` \| `"EVEN-PORT"` \| `"PASSWORD-ALGORITHM"` \| `"PASSWORD-ALGORITHMS"` \| `"XOR-RELAYED-ADDRESS"` \| `"RESERVATION-TOKEN"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"ALTERNATE-DOMAIN"` \| `"ALTERNATE-SERVER"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`)[]

#### Inherited from

`AttributeRepository.attributesKeys`

***

### bytes

#### Get Signature

> **get** **bytes**(): `Buffer`\<`ArrayBuffer`\>

##### Returns

`Buffer`\<`ArrayBuffer`\>

***

### integrityAlgorithm

#### Get Signature

> **get** **integrityAlgorithm**(): [`MessageIntegrityAlgorithm`](../type-aliases/MessageIntegrityAlgorithm.md) \| `undefined`

Integrity attribute this message is signed with: MESSAGE-INTEGRITY-SHA256
when present (it takes precedence, RFC 8489 §9.1.4), otherwise
MESSAGE-INTEGRITY, otherwise undefined. A parsed message only keeps the
integrity attributes parseMessage accepted in their RFC 8489 positions.

##### Returns

[`MessageIntegrityAlgorithm`](../type-aliases/MessageIntegrityAlgorithm.md) \| `undefined`

***

### json

#### Get Signature

> **get** **json**(): `object`

##### Returns

`object`

###### attributes

> **attributes**: `AttributePair`[]

###### messageClass

> **messageClass**: [`classes`](../enumerations/classes.md)

###### messageMethod

> **messageMethod**: [`methods`](../enumerations/methods.md)

###### rawAttributes

> **rawAttributes**: `object`[]

***

### transactionIdHex

#### Get Signature

> **get** **transactionIdHex**(): `string`

##### Returns

`string`

***

### unknownAttributeTypes

#### Get Signature

> **get** **unknownAttributeTypes**(): `number`[]

##### Returns

`number`[]

## Methods

### addFingerprint()

> **addFingerprint**(): `Message`

#### Returns

`Message`

***

### addIntegrity()

> **addIntegrity**(`key`, `mode?`): `Message`

Sign with the short-term credential `key` using the integrity attributes
`mode` selects (`"sha1"` = MESSAGE-INTEGRITY, `"sha256"` =
MESSAGE-INTEGRITY-SHA256, `"both"` = both in RFC 8489 order). Chain
`addFingerprint()` afterwards.

#### Parameters

##### key

`Buffer`

##### mode?

[`MessageIntegrityMode`](../type-aliases/MessageIntegrityMode.md) = `"sha1"`

#### Returns

`Message`

***

### addMessageIntegrity()

> **addMessageIntegrity**(`key`): `Message`

Add MESSAGE-INTEGRITY (HMAC-SHA1) over the current attributes.

#### Parameters

##### key

`Buffer`

#### Returns

`Message`

***

### addMessageIntegritySha256()

> **addMessageIntegritySha256**(`key`, `length?`): `Message`

Add MESSAGE-INTEGRITY-SHA256 (HMAC-SHA256, RFC 8489 §14.6) over the
current attributes, including a preceding MESSAGE-INTEGRITY.
`length` truncates the HMAC: 16 to 32 bytes in steps of 4.

#### Parameters

##### key

`Buffer`

##### length?

`number` = `INTEGRITY_SHA256_VALUE_LENGTH`

#### Returns

`Message`

***

### appendRawAttribute()

> **appendRawAttribute**(`type`, `value`): `Message`

#### Parameters

##### type

`number`

##### value

`Buffer`

#### Returns

`Message`

***

### clear()

> **clear**(): `void`

#### Returns

`void`

#### Inherited from

`AttributeRepository.clear`

***

### getAttributes()

> **getAttributes**(): `AttributePair`[]

#### Returns

`AttributePair`[]

#### Inherited from

`AttributeRepository.getAttributes`

***

### getAttributeValue()

> **getAttributeValue**(`key`): `any`

#### Parameters

##### key

`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"MESSAGE-INTEGRITY-SHA256"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"USERHASH"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"UNKNOWN-ATTRIBUTES"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"REQUESTED-ADDRESS-FAMILY"` \| `"EVEN-PORT"` \| `"PASSWORD-ALGORITHM"` \| `"PASSWORD-ALGORITHMS"` \| `"XOR-RELAYED-ADDRESS"` \| `"RESERVATION-TOKEN"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"ALTERNATE-DOMAIN"` \| `"ALTERNATE-SERVER"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`

#### Returns

`any`

#### Inherited from

`AttributeRepository.getAttributeValue`

***

### messageIntegrity()

> **messageIntegrity**(`key`): `Buffer`\<`ArrayBuffer`\>

HMAC-SHA1 MESSAGE-INTEGRITY value for the current attributes.

#### Parameters

##### key

`Buffer`

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### removeAttribute()

> **removeAttribute**(`key`): `Message`

Remove the attribute named `key`, if present.

#### Parameters

##### key

`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"MESSAGE-INTEGRITY-SHA256"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"USERHASH"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"UNKNOWN-ATTRIBUTES"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"REQUESTED-ADDRESS-FAMILY"` \| `"EVEN-PORT"` \| `"PASSWORD-ALGORITHM"` \| `"PASSWORD-ALGORITHMS"` \| `"XOR-RELAYED-ADDRESS"` \| `"RESERVATION-TOKEN"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"ALTERNATE-DOMAIN"` \| `"ALTERNATE-SERVER"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`

#### Returns

`Message`

#### Inherited from

`AttributeRepository.removeAttribute`

***

### setAttribute()

> **setAttribute**(`key`, `value`): `Message`

#### Parameters

##### key

`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"MESSAGE-INTEGRITY-SHA256"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"USERHASH"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"UNKNOWN-ATTRIBUTES"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"REQUESTED-ADDRESS-FAMILY"` \| `"EVEN-PORT"` \| `"PASSWORD-ALGORITHM"` \| `"PASSWORD-ALGORITHMS"` \| `"XOR-RELAYED-ADDRESS"` \| `"RESERVATION-TOKEN"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"ALTERNATE-DOMAIN"` \| `"ALTERNATE-SERVER"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`

##### value

`any`

#### Returns

`Message`

#### Inherited from

`AttributeRepository.setAttribute`

***

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### attributes

> **attributes**: `AttributePair`[]

##### messageClass

> **messageClass**: [`classes`](../enumerations/classes.md)

##### messageMethod

> **messageMethod**: [`methods`](../enumerations/methods.md)

##### rawAttributes

> **rawAttributes**: `object`[]
