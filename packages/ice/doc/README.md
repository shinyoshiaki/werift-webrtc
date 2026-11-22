**werift-ice**

***

# werift-ice

ICE/STUN-client/TURN-client Implementation for TypeScript  
based on aioice

The TURN client is exercised against the local `werift-ice-server`
reference TURN server over UDP, TCP, and TLS (`turns:`) control transports.

## TURN server endpoint selection

- One allocation keeps one concrete server endpoint for its lifetime. Allocate
  retries, Refresh, CreatePermission, ChannelBind, Send indications and
  ChannelData never look the hostname up again.
- UDP: the socket family comes from an IP literal server address. For a
  hostname it comes from `udpFamily` (`IceOptions.turnUdpFamily`,
  `PeerConfig.turnUdpFamily` in `werift`), default `4`, and the hostname is
  resolved in that family. `udpFamily` is ignored for an IP literal.
- TCP/TLS: the endpoint is the peer the stream connected to
  (`Transport.remoteAddress`); the hostname is not resolved again. TLS still
  verifies the certificate against the configured hostname. SNI is sent only
  when `tlsOptions.servername` is set.
- `TurnProtocol.configuredServer` always holds the configured address.
  `TurnProtocol.server` is the server the allocation lives on (the configured
  one unless the Allocate was redirected, see below); the resolved endpoint
  is `TurnProtocol.serverEndpoint`.

## TURN 300 (Try Alternate)

An Allocate answered with `300 (Try Alternate)` is retried against its
`ALTERNATE-SERVER` (RFC 8656 §7.4, RFC 8489 §10):

- Same transport protocol and the same username/password. The alternate
  starts with an unauthenticated Allocate and its own 401 realm/nonce; the
  previous server's realm/nonce are not reused.
- After the redirect, the allocation and every later Refresh,
  CreatePermission, ChannelBind and data packet are pinned to the alternate.
- When a 300 carries several `ALTERNATE-SERVER` attributes (e.g. one per IP
  family), the first one the socket's IP family can reach is used.
- UDP keeps the same socket. An alternate of the other IP family only fails
  with `AddressFamilyMismatch` when no listed alternate matches.
- TCP/TLS (via `createTurnClient`) close the stream and connect to the
  alternate. TLS validates the alternate's certificate against
  `ALTERNATE-DOMAIN` when present, otherwise against the name the original
  server is validated with (`tlsOptions.servername`, else the configured
  host). `new TurnProtocol(...)` over a stream needs the `reconnect` option to
  follow a redirect.
- Only Allocate is redirected. A redirect fails with `TurnRedirectError`
  (`reason`: `missing-alternate`, `loop` for a server already tried by this
  Allocate, including the resolved IP of a configured host name, `too-many-redirects` beyond `maxAllocateRedirects` (default 3),
  or `unsupported-transport`).

## MESSAGE-INTEGRITY-SHA256 (RFC 8489)

Connectivity checks and consent requests use the ICE short-term credential
(`ice-pwd`) as the HMAC key with either integrity attribute:

- Receiving: `parseMessage(data, key)` verifies `MESSAGE-INTEGRITY` (HMAC-SHA1)
  and `MESSAGE-INTEGRITY-SHA256` (HMAC-SHA256, truncated to 16-32 bytes in
  steps of 4). When both are present only `MESSAGE-INTEGRITY-SHA256` is
  verified (RFC 8489 §9.1.4); a malformed truncation length is rejected.
  Attributes after `MESSAGE-INTEGRITY` other than `MESSAGE-INTEGRITY-SHA256` /
  `FINGERPRINT`, and after `MESSAGE-INTEGRITY-SHA256` other than
  `FINGERPRINT`, are ignored (RFC 8489 §14.5 / §14.6).
  `Message.integrityAlgorithm` tells which one a message is signed with.
  Responses signed with only SHA-256 are accepted over UDP, TCP and TURN.
- Responding: a Binding success or error response is signed with
  `MESSAGE-INTEGRITY-SHA256` when the request carried it, otherwise with
  `MESSAGE-INTEGRITY` (RFC 8489 §9.1.3).
- Sending: `IceOptions.messageIntegrity` (`PeerConfig.iceMessageIntegrity` in
  `werift`) selects `"sha1"` (default), `"sha256"` or `"both"`. The default
  stays SHA-1 because `MESSAGE-INTEGRITY-SHA256` (0x001C) is a
  comprehension-required attribute that libwebrtc / Firefox do not implement
  for ICE: a peer that does not know it can reject the check (420) or drop it.
  Use `"sha256"` / `"both"` only with peers known to support it.
- Building messages: `Message.addMessageIntegritySha256(key, length = 32)`,
  or `addIntegrity(key, mode)` for the attributes `mode` selects, in the order
  `MESSAGE-INTEGRITY` -> `MESSAGE-INTEGRITY-SHA256` -> `FINGERPRINT`.
  `TransactionRequestOptions.integrityAlgorithm` passes the choice to
  `Protocol.request()`.

The `ice2` ice-option (RFC 8445 §10) is only a declaration and does not
negotiate SHA-256. `Connection.setRemoteIceOptions()` records the remote
`a=ice-options` tokens and `Connection.remoteIce2` reports `ice2`; werift
already runs the RFC 8445 procedures, so no token changes its behavior.

Not covered here:

- The integrity of incoming connectivity checks is not verified yet (no 401
  for a check the local password cannot verify); this is a separate change.
- TURN long-term credentials stay `MESSAGE-INTEGRITY` only. SHA-256 there needs
  the `PASSWORD-ALGORITHM(S)` / `USERHASH` negotiation of RFC 8489 §9.2 in
  both the client and `werift-ice-server`, which is out of scope.

## Consent freshness (RFC 7675)

- The selected pair gets a consent check every 4–6 s (5 s × 0.8–1.2, measured
  between request starts; never sooner than 4 s without failover). Each check
  is sent once (no retransmission) with a fresh transaction ID.
- A check's transaction stays open for 30 s (`CONSENT_TIMEOUT`), whatever the
  RTT estimate: a later check does not cancel it, so a response that arrives
  after the next check (an RTT that rose after the selection, an RTT longer
  than the interval, responses out of order) still refreshes the consent, as
  §5.1 allows ("the response may be for a previous request"). At most
  `CONSENT_MAX_OUTSTANDING_REQUESTS` (8) are open at once; beyond that the
  oldest one ends.
- The response must come from the pair's remote address, with a valid
  MESSAGE-INTEGRITY (the remote password), for the current selected pair,
  remote generation and consent session. The current RTT of the pair is taken
  from the newest request answered.
- 30 s without such a response, consent expires: the agent stops sending on
  the pair (`failed`, or failover's grace), and every open consent transaction
  is discarded, so a response that arrives later does not bring consent back.
  `close()`, an ICE restart and a new selection discard them as well.

## Failover of the selected pair (no ICE restart)

With semi-aggressive nomination (the default) or negotiated renomination,
a full ICE agent keeps checking one backup pair per local socket after the
selection, as libwebrtc (Chrome) keeps pinging its connections, and moves
the selection to a working backup when the selected pair stops answering,
without an ICE restart (TURN server down, NAT rebinding, Wi-Fi ↔ cellular,
a path broken in one direction).

- Backups: one pair per local socket (a UDP socket, whose host and
  server-reflexive candidates share one path, or a TURN allocation over UDP /
  TCP / TLS): its highest-priority pair that did not fail, above or below the
  selection and whatever the role. On the selected pair's own socket it is a
  pair to another remote address, so the agent also fails over when only
  the remote side of the path breaks (the peer's host goes away while its
  relay still answers); after such a move only the old remote address waits
  for its 3 responses. One exception: a controlling agent leaves the pairs
  that outrank the selection on its socket to the checks that move the
  selection up; those are retried after 1, 2, 4, 8, 16 s and then every
  16 s, and checked at once when the selection is unwritable with no
  writable backup. A backup that never answers (5 checks and 5 s) or receives
  nothing for 30 s fails and the next pair of its socket follows, up to 3
  pairs; then the socket starts again from its best pair after 1, 2, 4, 8,
  16 s, and then every 16 s for as long as the selection lasts, so a path
  that comes back after a long outage is found again. Candidates gathered or trickled after the selection still form
  backup pairs, and one that outranks a socket's backup replaces it. Backups are checked without a nomination, every 900 ms
  until they answered 3 times (and while a check goes unanswered), then
  every 2.5 s (0.8–1.2 times), without waiting for a check still in
  flight. Until a backup answered, its response timeout is 3 s
  (`BACKUP_UNKNOWN_RTT_RESPONSE_TIMEOUT`, libwebrtc's `DEFAULT_RTT`).
- The selected pair is checked by the consent checks (every 4–6 s). While it
  is weak they are sent every 900 ms: after an unanswered check, and as soon
  as nothing (response, request or data) was received for 2.5 s, so an idle
  pair is checked about every 2.5 s, from the first check after a selection
  on. Checks keep this pacing while earlier
  ones still wait for a response: a slow response is
  never cancelled and still counts, and a dead high-RTT path is still told
  within the bound (about 8.7 s with an RTT of 1.2 s). A check counts as
  unanswered at its RTT-based deadline, but its transaction stays open for
  30 s as every consent check's does (see "Consent freshness" below), so a
  late response (a busy event loop, a delayed path) still counts. The 900 ms
  pacing of a weak selected pair is shorter than the 4 s minimum of RFC 7675
  §5.1; it follows libwebrtc, which checks a weak selected connection the same
  way, and applies only with failover and only while the pair is weak. The pair is unwritable once 5
  checks in a row went unanswered and 5 s passed since its last response
  (libwebrtc's `CONNECTION_WRITE_CONNECT_FAILURES` /
  `CONNECTION_WRITE_CONNECT_TIMEOUT`), about 5–10 s after the path broke.
- Controlling agent: it then nominates the best writable backup (one that is
  not weak first) with `USE-CANDIDATE` (semi-aggressive) or the next
  `NOMINATION` value (renomination); the selection, consent and application
  data move to it when the peer answers. The old pair stays a backup of its
  socket, and the selection moves back to that socket only after it answered
  3 checks in a row. This also holds when the old pair answers again while
  the failover nomination is in flight: the nomination is not withdrawn (the
  peer may already have taken it), and when it succeeds the selection moves
  and the old socket waits for its 3 responses.
- Stopped receiving (libwebrtc's `receiving` and `receiving_switching_delay`):
  the controlling agent does not wait for the unwritable rule when nothing
  was received on the selected pair for 2.5 s + 1 s and one of its checks
  went unanswered meanwhile; it fails over to the best backup that receives
  (its last check answered, something received within 2.5 s), about 4 s
  after a path broke both ways. An idle pair whose checks are answered, a
  slow path whose checks are answered before their deadline, a shorter loss
  burst and a break of one direction only (the peer's data still arrives)
  keep the unwritable rule. Only writability and receiving switch pairs (no
  RTT or network-cost switching).
- A path reported gone fails over at once (as libwebrtc drops the
  connections of a port that is gone): the protocol's `onPathBroken` makes
  the monitored pairs on it unwritable until one of their checks is
  answered again. A UDP socket reports a routing error of a send
  (`ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`, `EHOSTDOWN`, `EADDRNOTAVAIL`,
  `EPERM`: `PATH_BROKEN_SEND_ERRORS`) for that remote address; STUN messages
  are always sent with a completion callback (`TransportSendOptions.confirm`)
  and application data one datagram per 100 ms per socket
  (`DATA_SEND_CONFIRM_INTERVAL_MS`), so a route that goes away while data
  flows is seen within about 100 ms. A TURN allocation reports every path of
  it (`TurnProtocol.onAllocationLost`) when its TCP / TLS connection to the
  server closes, a Refresh fails, or the server cannot be reached. The
  selected pair is then checked at the weak interval, so a path that comes
  back is seen within about 1 s. A path that is gone without an error (a
  remote host that went away, a firewall that drops) still takes the
  receiving / unwritable rules.
- A role change (role-conflict repair) cancels the checks in flight that
  carry the old role, backups' and the selected pair's consent requests
  alike; they are not counted as unanswered, and monitoring goes on under
  the new role.
- Controlled agent: it monitors the same way but never nominates; it follows
  the peer's nomination and the pair the peer sends data on. While its
  selected pair is down or stopped receiving, a nomination as strong as the
  selection's
  (USE-CANDIDATE again) of a valid pair moves the selection at once, without
  waiting for data, as libwebrtc's controlled agent ranks writability first.
- State: `disconnected` while the selected pair is unwritable and no backup
  is writable, back to `connected` only once the selected pair works again:
  it answers again, or the selection moved to a backup (a backup that merely
  answers again does not end `disconnected`). When the selected pair's
  consent expires (30 s, RFC 7675) nothing more is sent on it and it is not
  checked again: with no writable backup the agent is `failed`; with one it
  is `disconnected` and waits up to 10 s
  (`FAILOVER_CONSENT_EXPIRED_GRACE`) for the selection to move to a backup
  (its own failover nomination, or the peer's when controlled), then fails.
  An ICE restart recovers a `failed` agent.
- Not covered (unchanged: no backup checks, `failed` when consent expires):
  regular nomination (`nomination: "regular"`; RFC 8445 §8.1.1 allows no
  other pair without an ICE restart), ICE-TCP selections (a closed selected
  TCP connection fails the agent at once) and ICE-lite on either side.
- The constants are exported from `iceBase.ts`
  (`WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL`,
  `STABLE_WRITABLE_CONNECTION_PING_INTERVAL`,
  `CONNECTION_WRITE_CONNECT_FAILURES`, `RECEIVING_SWITCHING_DELAY`, ...),
  with their libwebrtc names.
- Thresholds (`IceOptions.failover`, `PeerConfig.iceFailover` in `werift`),
  after libwebrtc's `RTCConfiguration` fields; each unset or invalid value
  keeps its default:

  | Option | Default | libwebrtc |
  | --- | --- | --- |
  | `unwritableMinChecks` | 5 | `ice_unwritable_min_checks` |
  | `unwritableTimeout` (ms) | 5000 | `ice_unwritable_timeout` |
  | `receivingTimeout` (ms) | 2500 | `receiving_timeout` |
  | `receivingSwitchingDelay` (ms) | 1000 | `receiving_switching_delay` |

  ```ts
  new Connection(true, {
    failover: { receivingTimeout: 1000, receivingSwitchingDelay: 0 },
  });
  ```

  Lower values fail over sooner, and also on a shorter loss burst.

## pion TURN interop (opt-in)

Default `npm test` skips third-party TURN tests. To exercise werift ICE against
[pion/turn](https://github.com/pion/turn) in Docker (dynamic free UDP port, plus a TCP-control-connection server on a free TCP port exported as `PION_TURN_TCP_PORT`):

```bash
# Recommended: start → run tests → always docker compose down (trap)
npm run test:pion-turn --workspace packages/ice

# Or manually:
eval "$(./packages/ice/scripts/run-pion-turn.sh --print-env)"
# exports: PION_TURN_HOST, PION_TURN_PORT, PION_TURN_USERNAME, PION_TURN_PASSWORD, ...
PION_TURN_HOST="$PION_TURN_HOST" PION_TURN_PORT="$PION_TURN_PORT" \
  PION_TURN_USERNAME="$PION_TURN_USERNAME" PION_TURN_PASSWORD="$PION_TURN_PASSWORD" \
  npm test --workspace packages/ice -- pion-turn
./packages/ice/scripts/run-pion-turn.sh --down
```

| Env | Required | Default |
|-----|----------|---------|
| `PION_TURN_HOST` | yes (opt-in gate) | set by script (`127.0.0.1`) |
| `PION_TURN_PORT` | no | script dynamic port / `3478` |
| `PION_TURN_USERNAME` | no | `username` |
| `PION_TURN_PASSWORD` | no | `password` |
| `PION_TURN_PUBLIC_IP` | no | `127.0.0.1` |

Scripts: `packages/ice/scripts/run-pion-turn.sh`  
Compose: `packages/ice/docker/pion-turn/` (`network_mode: host`, free `UDP_PORT`), `packages/ice/docker/pion-turn-tcp/` (free `TCP_PORT`)
