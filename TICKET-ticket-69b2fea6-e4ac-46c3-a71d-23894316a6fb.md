## Summary

The DTLS server can sign `ServerKeyExchange` and derive handshake keys using the random from the initial cookie-less `ClientHello`, even when the accepted cookie-authenticated `ClientHello` carries a different random.

This has been reproduced against Apple Home / HKSV3 remote H.265 live view: ICE succeeds, but the peer rejects the DTLS handshake with `fatal decrypt_error (51)`.

## Current behavior

In `packages/dtls/src/server.ts`, the cookie-authenticated `ClientHello` is deserialized and accepted, but `cipher.remoteRandom` is not refreshed before Flight 4 is generated.

The current develop code effectively does:

```ts
const clientHello = ClientHello.deSerialize(handshake.fragment);

if (clientHello.cookie.length === 0) {
  flight2(...)(clientHello);
} else if (
  this.dtls.cookie &&
  clientHello.cookie.equals(this.dtls.cookie)
) {
  await new Flight4(...).exec(handshake, ...);
}
```

If the second `ClientHello.random` differs from the first, Flight 4 may therefore use a stale peer random.

## Expected behavior

Once the cookie-authenticated `ClientHello` is accepted, the DTLS server should use that accepted hello's random for the ServerKeyExchange signature and key derivation.

Retransmitting an already-generated Flight 4 should continue to reuse the accepted random / cached flight rather than replacing it again.

## Downstream reproduction and proposed fix

Scrypted users reproduced this with Apple Home HKSV3 remote H.265 live view:

- ICE reaches connected.
- Apple sends a cookie-authenticated ClientHello whose random differs from the initial hello.
- The ServerKeyExchange signature does not verify against the accepted ClientHello.
- Apple returns `fatal decrypt_error (51)`.
- Updating `cipher.remoteRandom` from the accepted cookie-authenticated ClientHello restores remote live view.

A downstream werift fork PR includes a focused regression test that verifies the ECDSA signature for both unchanged and changed ClientHello randoms:

https://github.com/koush/werift-webrtc/pull/4

Related Scrypted report:

https://github.com/koush/scrypted/issues/2167

## Suggested fix

Before creating the first Flight 4 for a valid cookie-authenticated ClientHello, refresh the peer random from that accepted ClientHello, e.g. conceptually:

```ts
if (this.dtls.flight !== 4) {
  this.cipher.remoteRandom = DtlsRandom.from(clientHello.random);
}
```

The exact guard should preserve the already accepted random on Flight 4 retransmission.

## Regression tests

Please cover at least:

1. Initial ClientHello and cookie-authenticated ClientHello use the same random.
2. Cookie-authenticated ClientHello uses a different random.
3. ServerKeyExchange signature verifies against the accepted ClientHello random.
4. Flight 4 retransmission reuses the accepted random and cached messages.

Observed on the current downstream fork and still present in upstream develop as of 2026-10-17.