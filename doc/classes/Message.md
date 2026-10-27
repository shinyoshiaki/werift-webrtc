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

Every ALTERNATE-SERVER attribute, in wire order.

#### Returns

`Message`

#### Overrides

`AttributeRepository.constructor`

## Properties

### alternateServers

> **alternateServers**: \[`string`, `number`\][] = `[]`

Every ALTERNATE-SERVER attribute, in wire order.

***

### attributes

> `protected` **attributes**: `AttributePair`[] = `[]`

#### Inherited from

`AttributeRepository.attributes`

***

### messageClass

> **messageClass**: [`classes`](../enumerations/classes.md)

***

### messageMethod

> **messageMethod**: [`methods`](../enumerations/methods.md)

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

### rawAttributes

#### Get Signature

> **get** **rawAttributes**(): `RawAttribute`[]

Unknown (not in ATTRIBUTES) attributes in wire order.
Live array: `push` / `reverse` / in-place edits are serialized.

##### Returns

`RawAttribute`[]

#### Set Signature

> **set** **rawAttributes**(`value`): `void`

##### Parameters

###### value

`RawAttribute`[]

##### Returns

`void`

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

### addMessageIntegrity()

> **addMessageIntegrity**(`key`): `Message`

#### Parameters

##### key

`Buffer`

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

#### Parameters

##### key

`Buffer`

#### Returns

`Buffer`\<`ArrayBuffer`\>

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

#### Overrides

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
