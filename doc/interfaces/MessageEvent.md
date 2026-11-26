[**werift**](../README.md)

***

[werift](../globals.md) / MessageEvent

# Interface: MessageEvent

## Properties

### data

> **data**: [`RTCDataChannelMessageData`](../type-aliases/RTCDataChannelMessageData.md)

A string for a text message; a binary message by the channel's
`binaryType` (`Buffer` by default). Use [RTCDataChannel.onMessage](../classes/RTCDataChannel.md#onmessage-1)
for code that always wants a `Buffer` or a string.

***

### type?

> `readonly` `optional` **type?**: `string`

`"message"` on received messages.
