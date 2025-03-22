[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / Message

# Class: Message

## Extends

- `AttributeRepository`

## Constructors

### new Message()

> **new Message**(`messageMethod`, `messageClass`, `transactionId`, `attributes`): [`Message`](Message.md)

#### Parameters

• **messageMethod**: [`methods`](../enumerations/methods.md)

• **messageClass**: [`classes`](../enumerations/classes.md)

• **transactionId**: `Buffer` = `...`

• **attributes**: `AttributePair`[] = `[]`

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

### transactionId

> **transactionId**: `Buffer`

## Accessors

### attributesKeys

> `get` **attributesKeys**(): (`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"XOR-RELAYED-ADDRESS"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`)[]

#### Returns

(`"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"XOR-RELAYED-ADDRESS"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`)[]

#### Inherited from

`AttributeRepository.attributesKeys`

***

### bytes

> `get` **bytes**(): `Buffer`

#### Returns

`Buffer`

***

### json

> `get` **json**(): `object`

#### Returns

`object`

##### attributes

> **attributes**: `AttributePair`[]

##### messageClass

> **messageClass**: `string`

##### messageMethod

> **messageMethod**: `string`

***

### transactionIdHex

> `get` **transactionIdHex**(): `string`

#### Returns

`string`

## Methods

### addFingerprint()

> **addFingerprint**(): `void`

#### Returns

`void`

***

### addMessageIntegrity()

> **addMessageIntegrity**(`key`): [`Message`](Message.md)

#### Parameters

• **key**: `Buffer`

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

### getAttributeValue()

> **getAttributeValue**(`key`): `any`

#### Parameters

• **key**: `"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"XOR-RELAYED-ADDRESS"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`

#### Returns

`any`

#### Inherited from

`AttributeRepository.getAttributeValue`

***

### getAttributes()

> **getAttributes**(): `AttributePair`[]

#### Returns

`AttributePair`[]

#### Inherited from

`AttributeRepository.getAttributes`

***

### messageIntegrity()

> **messageIntegrity**(`key`): `Buffer`

#### Parameters

• **key**: `Buffer`

#### Returns

`Buffer`

***

### setAttribute()

> **setAttribute**(`key`, `value`): [`Message`](Message.md)

#### Parameters

• **key**: `"FINGERPRINT"` \| `"MESSAGE-INTEGRITY"` \| `"CHANGE-REQUEST"` \| `"PRIORITY"` \| `"USERNAME"` \| `"ICE-CONTROLLING"` \| `"SOURCE-ADDRESS"` \| `"USE-CANDIDATE"` \| `"ICE-CONTROLLED"` \| `"ERROR-CODE"` \| `"XOR-MAPPED-ADDRESS"` \| `"CHANGED-ADDRESS"` \| `"LIFETIME"` \| `"REQUESTED-TRANSPORT"` \| `"NONCE"` \| `"REALM"` \| `"XOR-RELAYED-ADDRESS"` \| `"CHANNEL-NUMBER"` \| `"XOR-PEER-ADDRESS"` \| `"DATA"` \| `"SOFTWARE"` \| `"MAPPED-ADDRESS"` \| `"RESPONSE-ORIGIN"` \| `"OTHER-ADDRESS"`

• **value**: `any`

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

> **messageClass**: `string`

##### messageMethod

> **messageMethod**: `string`
