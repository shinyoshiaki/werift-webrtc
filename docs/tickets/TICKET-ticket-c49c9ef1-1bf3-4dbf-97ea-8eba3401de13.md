# Bug: DataChannel maxPacketLifeTime expiry mixes ms and seconds, so lifetime-based abandon does not work

Found while fixing ticket 340fdd75 (DCEP unordered channel types).

## 1. Purpose and background

`RTCDataChannel.maxPacketLifeTime` is in **milliseconds** (W3C WebRTC `RTCDataChannelInit.maxPacketLifeTime`; RFC 8832 §5.1, the DCEP `Reliability Parameter` for `DATA_CHANNEL_PARTIAL_RELIABLE_TIMED`). A message that is still unacknowledged after that many ms should be abandoned with PR-SCTP (RFC 3758), and FORWARD-TSN should move the peer's cumulative TSN past it.

werift mixes units along this path, so a lifetime-limited chunk is **never** abandoned:

| Location | Current code | Unit |
| --- | --- | --- |
| `packages/webrtc/src/transport/sctp.ts` `dataChannelFlush()` (~L343-346) | `Date.now() + channel.maxPacketLifeTime / 1000` | epoch **ms** + lifetime in **s** (lifetime shrinks 1000x, but the value is still about 1.7e12) |
| `packages/sctp/src/sctp.ts` `maybeAbandon()` (~L1349-1353) | `chunk.expiry < Date.now() / 1000` | compares in epoch **seconds** (about 1.7e9) |
| `packages/webrtc/src/dataChannel.ts` `RTCDataChannelParameters` (L161) | `maxPacketLifeTime?: number; // sec` | comment is wrong (the value is ms) |

So `expiry` (about 1.7e12) is always greater than `Date.now()/1000` (about 1.7e9), and `maybeAbandon()` never abandons on lifetime. The only effect of `maxPacketLifeTime` today is the DCEP OPEN channel type and reliability value.

Notes:
- `packages/sctp/tests/mtu.test.ts:98` already passes `expiry: Date.now() + 10_000` (epoch ms). The tests already assume the `expiry` contract is epoch ms.
- On the receive side, DCEP OPEN `reliability` goes into `maxPacketLifeTime` unchanged (`transport/sctp.ts` ~L166-176). That is ms and correct as is.
- The DCEP OPEN send side (`reliability = channel.maxPacketLifeTime`, L273-276) is also ms and correct as is.

## 2. Changes to implement

1. **Use one unit (epoch ms) for `expiry`** (recommended)
   - `packages/sctp/src/sctp.ts` `maybeAbandon()`: change `chunk.expiry < Date.now() / 1000` to `chunk.expiry <= Date.now()` (or `<`).
   - `packages/webrtc/src/transport/sctp.ts` `dataChannelFlush()`: change `Date.now() + channel.maxPacketLifeTime / 1000` to `Date.now() + channel.maxPacketLifeTime`.
   - Add TSDoc to the `expiry` option of `SCTP.send()` and to `DataChunk.expiry` (`packages/sctp/src/chunk.ts:198`) saying it is "absolute time in `Date.now()` epoch milliseconds".
2. **Fix the comment**: change `// sec` in `RTCDataChannelParameters.maxPacketLifeTime` to milliseconds. Writing it as TSDoc (`/** Lifetime in milliseconds (RFC 8832 / WebRTC). */`) also carries it into the generated docs.
3. **Add tests** (see section 3).
4. **Update docs and changelog**
   - Add a Fix entry to `changelog.md` `## Unreleased`: DataChannel `maxPacketLifeTime` now abandons messages after the given ms.
   - `werift-sctp`: `SCTP.send({ expiry })` is now interpreted as epoch ms. A caller that passed epoch seconds would now see every chunk abandoned at its first retransmission decision, so record this under ⚠️ Breaking changes (or as a clear behavior change).
   - If TSDoc changes, regenerate with `npm run doc` (`doc/classes/RTCDataChannelParameters.md` and others). Don't edit generated docs by hand.

### Alternative (not recommended)

Keep sctp in seconds and change webrtc to `(Date.now() + maxPacketLifeTime) / 1000`. This conflicts with the existing tests (mtu.test.ts) that use ms, uses floating-point seconds, and doesn't match `Date.now()`. Prefer unifying on ms.

## 3. Technical approach (findings)

### When abandonment is evaluated
`maybeAbandon()` is only called when a retransmission decision is made:
- `timer3Expired()` (~L1197-1206): runs over every chunk in `sentQueue`, then `updateAdvancedPeerAckPoint()`
- When SACK gap reports reach `misses === 3` (fast retransmit, ~L725-741), then `updateAdvancedPeerAckPoint()` (~L781)

`updateAdvancedPeerAckPoint()` (~L1324-1347) takes the abandoned chunks off the front of `sentQueue` and builds `forwardTsnChunk`. `transmitOnce()` (~L987-996) sends it before any other data. So chunks that are delivered without loss need no abandonment, and fixing the comparison is enough to meet the ticket's requirement.

### Test design (packages/sctp)
- Use `createConnectedSctpPair({ dropClient })` (`packages/sctp/tests/utils.ts`) and drop the client's DATA packets (`burst.test.ts` has a `dropDataPacketsAt`-style helper you can reuse; if you need a general one, move it into `tests/utils.ts`).
- Arrange: connected pair, a transport that drops the first transmission (and its retransmissions) of the target DATA chunk.
- Act: `client.send(streamId, ppid, data, { expiry: Date.now() + 100, ordered: true })`, then advance time past the lifetime and past T3 (initial RTO `SCTP_RTO_INITIAL = 3` s).
  - Real timers take 3 s or more. Consider `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })` + `vi.advanceTimersByTimeAsync()`. `MemoryTransport` uses `setImmediate`, so keep it out of `toFake` (see the existing fake-timer usage in `sctp.test.ts:133`).
- Assert:
  - The client sent a FORWARD-TSN (`ForwardTsnChunk.type`) and its `cumulativeTsn` is the abandoned chunk's TSN (parse sent packets with `parsePacket`, or check the DATA chunk did not stay in `client.sentQueue`).
  - The server's `lastReceivedTsn` moved to that TSN, and a following message on the same stream reaches the server's `onReceive` (it doesn't stall in ordered delivery).
  - Contrast case: a chunk with a long `expiry` (for example +10 s) is retransmitted, not abandoned, when T3 expires.
- Write Act / Assert comments in Japanese, and put shared Arrange code in `tests/utils.ts` (root AGENTS.md Do 6).

### Test design (packages/webrtc, optional)
- Spy on `RTCSctpTransport` and check that `sctp.send` receives `expiry ≈ Date.now() + maxPacketLifeTime` (in ms). One unit test that pins down the webrtc-side conversion is enough. An E2E-level test that loses packets is hard in werift-to-werift and is out of scope.

## 4. Constraints and cautions

- **Related bugs found nearby** (decide whether to fix them here or split them into tickets):
  1. `maybeAbandon()` searches with `this.sentQueue.findIndex((v) => v.type === chunk.type)`. Every DATA chunk has the same `type`, so this always returns the **first DATA chunk in sentQueue**. For a fragmented message, or when the target is not at the head, the wrong message's fragments get marked abandoned (aiortc uses `self._sent_queue.index(chunk)`). This is likely to show up once lifetime abandonment starts working, so **fixing it in the same change is recommended** (`findIndex((v) => v === chunk)`). Add a test that abandons a fragmented message and checks that all of its fragments, and only those, are marked.
  2. With `!!chunk.maxRetransmits`, `maxRetransmits: 0` (no retransmission) is falsy and is never abandoned. Out of scope for this ticket, but worth recording as a separate ticket.
  3. Chunks that are still in `outboundQueue` (never sent) are not checked for expiry. RFC 3758 allows abandoning before the first transmission, but that is optional and out of scope here.
- In the FORWARD-TSN `streams` list, unordered chunks are excluded (handled in `updateAdvancedPeerAckPoint`). Make sure ticket 340fdd75 (unordered channel types) still behaves correctly.
- FORWARD-TSN is sent only when `remotePartialReliability` is true (default true; L142/L559). The tests use werift-to-werift, so this holds.
- Changing the meaning of `expiry` in werift-sctp affects its public API. Record it in the changelog.
- Per root AGENTS.md: don't check out or stash the active worktree; compare against another revision only in a temporary worktree.

## 5. Done when

- [ ] `maxPacketLifeTime` (ms) is handled in ms from webrtc to sctp (no `/ 1000` mixing left in `dataChannelFlush()` or `maybeAbandon()`).
- [ ] The `RTCDataChannelParameters.maxPacketLifeTime` comment/TSDoc says milliseconds, and the `SCTP.send` `expiry` option has TSDoc saying epoch ms.
- [ ] New test in `packages/sctp/tests`: a lifetime-limited chunk that is not delivered is abandoned after the lifetime, a FORWARD-TSN is sent, and the receiver's cumulative TSN advances (Arrange / Act / Assert, Japanese comments).
- [ ] Contrast test: a chunk whose lifetime has not expired is retransmitted and not abandoned.
- [ ] (Recommended) The `maybeAbandon()` `findIndex` bug is fixed, with a fragment abandonment test.
- [ ] `changelog.md` `Unreleased` records the fix and the werift-sctp `expiry` unit change.
- [ ] If TSDoc changed, `npm run doc` has regenerated the docs.
- [ ] `cd packages/sctp && npm test`, `cd packages/webrtc && npm test` (at least the DataChannel / sctp tests), `npm run type`, and `npm run test:small` pass, and `npm run format` has been run.
