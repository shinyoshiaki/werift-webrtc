[**werift-ice**](../README.md) • **Docs**

***

[werift-ice](../globals.md) / IceOptions

# Interface: IceOptions

## Properties

### additionalHostAddresses?

> `optional` **additionalHostAddresses**: `string`[]

***

### filterCandidatePair()?

> `optional` **filterCandidatePair**: (`pair`) => `boolean`

#### Parameters

• **pair**: [`CandidatePair`](../classes/CandidatePair.md)

#### Returns

`boolean`

***

### filterStunResponse()?

> `optional` **filterStunResponse**: (`message`, `addr`, `protocol`) => `boolean`

#### Parameters

• **message**: [`Message`](../classes/Message.md)

• **addr**: readonly [`string`, `number`]

• **protocol**: [`Protocol`](Protocol.md)

#### Returns

`boolean`

***

### forceTurn?

> `optional` **forceTurn**: `boolean`

***

### interfaceAddresses?

> `optional` **interfaceAddresses**: `InterfaceAddresses`

***

### localPasswordPrefix?

> `optional` **localPasswordPrefix**: `string`

***

### portRange?

> `optional` **portRange**: [`number`, `number`]

***

### stunServer?

> `optional` **stunServer**: readonly [`string`, `number`]

***

### turnPassword?

> `optional` **turnPassword**: `string`

***

### turnServer?

> `optional` **turnServer**: readonly [`string`, `number`]

***

### turnTransport?

> `optional` **turnTransport**: `"udp"` \| `"tcp"`

***

### turnUsername?

> `optional` **turnUsername**: `string`

***

### useIpv4

> **useIpv4**: `boolean`

***

### useIpv6

> **useIpv6**: `boolean`
