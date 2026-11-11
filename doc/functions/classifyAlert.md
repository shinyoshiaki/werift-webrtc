[**werift**](../README.md)

***

[werift](../globals.md) / classifyAlert

# Function: classifyAlert()

> **classifyAlert**(`alert`): `"close"` \| `"fatal"` \| `"ignore"`

What the receiver does with an alert (RFC 5246 §7.2.1 / §7.2.2).

- `close`: close_notify (whatever its level). The connection is closed by
  the peer.
- `fatal`: any other alert with the fatal level. The connection is invalid.
- `ignore`: any other warning (user_canceled, no_renegotiation, ...).

## Parameters

### alert

[`DtlsAlert`](../interfaces/DtlsAlert.md)

## Returns

`"close"` \| `"fatal"` \| `"ignore"`
