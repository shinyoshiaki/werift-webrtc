[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / DataSendConfirmation

# Class: DataSendConfirmation

Which application-data datagrams of one socket are sent with `confirm`:
one per [DATA\_SEND\_CONFIRM\_INTERVAL\_MS](../variables/DATA_SEND_CONFIRM_INTERVAL_MS.md). Node.js reports a datagram's
send error only to a completion callback, which costs a round of the event
loop per packet; confirming a sample tells a path that is gone within that
interval while data flows, at a bounded cost.

## Constructors

### Constructor

> **new DataSendConfirmation**(): `DataSendConfirmation`

#### Returns

`DataSendConfirmation`

## Methods

### due()

> **due**(`now?`): `boolean`

The datagram sent now is one to confirm.

#### Parameters

##### now?

`number` = `...`

#### Returns

`boolean`
