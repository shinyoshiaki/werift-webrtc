[**werift**](../README.md)

***

[werift](../globals.md) / canonicalIceServerUrl

# Function: canonicalIceServerUrl()

> **canonicalIceServerUrl**(`url`): `string` \| `undefined`

The URL `icecandidateerror` reports for an `RTCIceServer` URL, or
undefined for a URL werift does not use (see parseIceServers). The rule:

- the configured URL without surrounding whitespace and with a lower-case
  scheme; host, port and query are kept as configured (no default port is
  added);
- only a `turns:` URL without a `transport` query gets `?transport=tcp`
  (`&transport=tcp` after another query): TLS over TCP is its default
  (RFC 7065 §3), so the URL still names the same server. This matches
  Chrome and upstream WPT.

`turn:`, `stun:` and `stuns:` are not changed; a `turn:` server whose UDP
allocation falls back to TCP keeps its `turn:` URL.

## Parameters

### url

`string`

## Returns

`string` \| `undefined`
