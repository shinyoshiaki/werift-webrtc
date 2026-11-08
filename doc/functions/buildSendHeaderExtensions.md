[**werift**](../README.md)

***

[werift](../globals.md) / buildSendHeaderExtensions

# Function: buildSendHeaderExtensions()

> **buildSendHeaderExtensions**(`original`, `negotiated`, `ids`): [`Extension`](../type-aliases/Extension.md)[]

Header extensions of an outgoing packet: the negotiated ones this sender
writes (MID, RID, repaired RID, placeholders for TWCC / abs-send-time),
then the input packet's other extensions, sorted by id.

TWCC and abs-send-time are hop-by-hop: a forwarded packet's values are not
kept, so the new transport-wide sequence assigned at send time is not
overwritten (see [stampHopByHopExtensions](stampHopByHopExtensions.md)).

## Parameters

### original

[`Extension`](../type-aliases/Extension.md)[]

### negotiated

[`NegotiatedHeaderExtension`](../type-aliases/NegotiatedHeaderExtension.md)[]

### ids

[`SendStreamIds`](../type-aliases/SendStreamIds.md)

## Returns

[`Extension`](../type-aliases/Extension.md)[]
