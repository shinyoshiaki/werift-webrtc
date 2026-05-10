[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / Message

# Class: Message

## Extends

- `AttributeRepository`

## Constructors

### new Message()

> **new Message**(`messageMethod`, `messageClass`, `transactionId`, `attributes`, `rawAttributes`): [`Message`](Message.md)

#### Parameters

##### messageMethod

[`methods`](../enumerations/methods.md)

##### messageClass

[`classes`](../enumerations/classes.md)

##### transactionId

`Buffer` = `...`

##### attributes

`AttributePair`[] = `[]`

##### rawAttributes

`RawAttribute`[] = `[]`

#### Returns

[`Message`](Message.md)

#### Overrides

`AttributeRepository.constructor`

## Properties

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

### rawAttributes

> **rawAttributes**: `RawAttribute`[] = `[]`

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

> **addFingerprint**(): [`Message`](Message.md)

#### Returns

[`Message`](Message.md)

***

### addMessageIntegrity()

> **addMessageIntegrity**(`key`): [`Message`](Message.md)

#### Parameters

##### key

`Buffer`

#### Returns

[`Message`](Message.md)

***

### appendRawAttribute()

> **appendRawAttribute**(`type`, `value`): [`Message`](Message.md)

#### Parameters

##### type

`number`

##### value

`Buffer`

#### Returns

[`Message`](Message.md)

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

`"FINGERPRINT"` | `"MESSAGE-INTEGRITY"` | `"MESSAGE-INTEGRITY-SHA256"` | `"CHANGE-REQUEST"` | `"PRIORITY"` | `"USERNAME"` | `"USERHASH"` | `"ICE-CONTROLLING"` | `"SOURCE-ADDRESS"` | `"USE-CANDIDATE"` | `"ICE-CONTROLLED"` | `"ERROR-CODE"` | `"UNKNOWN-ATTRIBUTES"` | `"XOR-MAPPED-ADDRESS"` | `"CHANGED-ADDRESS"` | `"LIFETIME"` | `"REQUESTED-TRANSPORT"` | `"NONCE"` | `"REALM"` | `"REQUESTED-ADDRESS-FAMILY"` | `"EVEN-PORT"` | `"PASSWORD-ALGORITHM"` | `"PASSWORD-ALGORITHMS"` | `"XOR-RELAYED-ADDRESS"` | `"RESERVATION-TOKEN"` | `"CHANNEL-NUMBER"` | `"XOR-PEER-ADDRESS"` | `"DATA"` | `"SOFTWARE"` | `"MAPPED-ADDRESS"` | `"ALTERNATE-DOMAIN"` | `"ALTERNATE-SERVER"` | `"RESPONSE-ORIGIN"` | `"OTHER-ADDRESS"`

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

> **setAttribute**(`key`, `value`): [`Message`](Message.md)

#### Parameters

##### key

`"FINGERPRINT"` | `"MESSAGE-INTEGRITY"` | `"MESSAGE-INTEGRITY-SHA256"` | `"CHANGE-REQUEST"` | `"PRIORITY"` | `"USERNAME"` | `"USERHASH"` | `"ICE-CONTROLLING"` | `"SOURCE-ADDRESS"` | `"USE-CANDIDATE"` | `"ICE-CONTROLLED"` | `"ERROR-CODE"` | `"UNKNOWN-ATTRIBUTES"` | `"XOR-MAPPED-ADDRESS"` | `"CHANGED-ADDRESS"` | `"LIFETIME"` | `"REQUESTED-TRANSPORT"` | `"NONCE"` | `"REALM"` | `"REQUESTED-ADDRESS-FAMILY"` | `"EVEN-PORT"` | `"PASSWORD-ALGORITHM"` | `"PASSWORD-ALGORITHMS"` | `"XOR-RELAYED-ADDRESS"` | `"RESERVATION-TOKEN"` | `"CHANNEL-NUMBER"` | `"XOR-PEER-ADDRESS"` | `"DATA"` | `"SOFTWARE"` | `"MAPPED-ADDRESS"` | `"ALTERNATE-DOMAIN"` | `"ALTERNATE-SERVER"` | `"RESPONSE-ORIGIN"` | `"OTHER-ADDRESS"`

##### value

`any`

#### Returns

[`Message`](Message.md)

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
