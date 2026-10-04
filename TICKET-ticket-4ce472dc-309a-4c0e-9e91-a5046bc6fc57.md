## Summary

werift's TURN client does not follow a TURN `300 Try Alternate` response containing `ALTERNATE-SERVER`.

This is an interoperability problem with TURN deployments that intentionally redirect an initial Allocate request to a regional or unicast relay.

A concrete production example is Microsoft Minecraft Realms: the Realm TURN endpoint returns `300 Try Alternate` on the first Allocate. Native libwebrtc follows the redirect and connects; werift 0.24.4 treats the response as a terminal `TransactionFailed`, gathers no relay candidate, and ICE eventually times out.

## Current behavior

`TurnProtocol.connectionMade()` sends Allocate through:

```ts
await this.requestWithRetry(request, this.server)
```

but `requestWithRetry()` only handles:

- `401 Unauthorized`
- `438 Stale Nonce`

All other TURN error responses are rethrown.

Current logic:

```ts
if (
  ((errorCode === 401 && realm) || (errorCode === 438 && this.realm)) &&
  nonce
) {
  // retry auth
} else {
  throw error;
}
```

The STUN attribute implementation already supports:

```ts
[0x8023, "ALTERNATE-SERVER", packAddress, unpackAddress]
```

so the missing piece is redirect handling in the TURN client.

## Standards behavior

RFC 8656 §7.4 says that on Allocate error `300 (Try Alternate)`, the client SHOULD try the Allocate request with the server specified by `ALTERNATE-SERVER` before trying other servers.

https://www.rfc-editor.org/rfc/rfc8656.html

RFC 8489 §10 defines the redirect procedure:

- retry against `ALTERNATE-SERVER`
- use the same transport protocol
- reuse the credentials that would have been used for the original server
- prevent redirect loops (a server already tried for this request within the last five minutes must not be followed again)
- for TLS/DTLS, honor `ALTERNATE-DOMAIN` when applicable

https://www.rfc-editor.org/rfc/rfc8489.html#section-10

## Downstream reproduction

PrismarineJS/node-nethernet reproduced this on a real Minecraft Bedrock Realm:

- stock werift 0.24.4: Realm connection times out
- native `@roamhq/wrtc` / libwebrtc: succeeds
- werift 0.24.4 plus a downstream pre-probe that rewrites the TURN URL to the returned `ALTERNATE-SERVER`: join + reconnect succeed with a live packet stream

Downstream PR:
https://github.com/PrismarineJS/node-nethernet/pull/29

The downstream workaround sends an unauthenticated Allocate probe, parses `300 + ALTERNATE-SERVER`, rewrites the configured TURN URL, and then lets werift perform its normal 401 authentication flow against the alternate server.

## Expected behavior

For an initial Allocate:

1. send Allocate to configured TURN server
2. receive `300 Try Alternate` with `ALTERNATE-SERVER`
3. consider the current transaction failed
4. retry Allocate against the alternate using the same transport protocol and credentials
5. continue normal `401 -> authenticated Allocate` handling
6. gather the relay candidate normally

## Implementation considerations

### UDP

For UDP, the existing transport can send to another server address, so the redirect can likely update the TURN server target and retry with a fresh transaction ID.

### TCP / TLS

For stream transports, following the redirect requires reconnecting the underlying transport to the alternate server. TLS also needs the RFC 8489 `ALTERNATE-DOMAIN` certificate-validation behavior.

It would be reasonable to land UDP support first if stream-transport redirect handling needs a separate change, but the API/logic should avoid silently treating 300 as authentication failure.

### Loop prevention

Track redirect targets for an allocation/request and reject ping-pong redirects as required by RFC 8489.

## Tests

Suggested tests:

1. Allocate receives `300 + ALTERNATE-SERVER` -> retries alternate
2. alternate returns `401` -> normal nonce/realm authentication succeeds
3. successful Allocate returns relay candidate from alternate
4. `300` without `ALTERNATE-SERVER` fails cleanly
5. redirect loop is rejected
6. credentials are preserved across the redirect
7. UDP redirect interoperability test
8. TCP/TLS redirect tests if supported in the same change

This issue is present on current `develop` and is confirmed against werift 0.24.4 in downstream production interoperability testing.