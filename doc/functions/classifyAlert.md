[**werift**](../README.md)

***

[werift](../globals.md) / classifyAlert

# Function: classifyAlert()

> **classifyAlert**(`alert`): `"close"` \| `"fatal"` \| `"ignore"`

What the receiver does with an alert (RFC 5246 §7.2.1 / §7.2.2).

- `close`: close_notify (whatever its level). The connection is closed by
  the peer.
- `ignore`: any other warning (user_canceled, no_renegotiation, ...).
- `fatal`: any other alert with the fatal level, or with a level that is
  neither warning nor fatal (malformed; OpenSSL / BoringSSL also end the
  connection on it). The connection is invalid.

## Parameters

### alert

[`DtlsAlert`](../interfaces/DtlsAlert.md)

## Returns

`"close"` \| `"fatal"` \| `"ignore"`
