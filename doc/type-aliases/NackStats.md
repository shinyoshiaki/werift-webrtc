[**werift**](../README.md)

***

[werift](../globals.md) / NackStats

# Type Alias: NackStats

> **NackStats** = `object`

Counters of the receiver-side NACK.

## Properties

### late

> **late**: `number`

Given-up packets that arrived afterwards (included in `unrecovered`).
Packets never received = `unrecovered - late`.

***

### lost

> **lost**: `number`

Packets detected as missing.

***

### pending

> **pending**: `number`

Missing packets still waiting for a retransmission.

***

### recovered

> **recovered**: `number`

Missing packets that arrived (retransmitted or reordered) before giving up.

***

### unrecovered

> **unrecovered**: `number`

Missing packets given up because the budget or retry count ran out.
