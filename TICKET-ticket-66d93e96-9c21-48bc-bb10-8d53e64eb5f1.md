## Summary

werift currently uses aggressive nomination for non-TCP candidate pairs. This can make the selected ICE pair depend on which connectivity check completes first rather than on the intended candidate-pair preference.

This was observed in a real Chrome ↔ werift deployment using TURN. A lower-priority relay path (TURN reached over TCP) completed first and was immediately nominated, while a higher-priority relay-over-UDP candidate became available shortly afterwards. The session then remained on the TCP relay path and accumulated severe latency even though the UDP relay path was usable.

Downstream reports / workarounds:

- Rkcr007/mfarm-cloud#258: https://github.com/Rkcr007/mfarm-cloud/pull/258
- Rkcr007/mfarm-cloud#259: https://github.com/Rkcr007/mfarm-cloud/pull/259

The downstream workaround is to hold the lower-priority relay candidate briefly so that the higher-priority UDP relay candidate can be checked first. That should not be necessary at the application layer.

## Current behavior

On current `develop`, `Connection.checkStart()` does this for every non-TCP pair:

```ts
const nominate =
  this.iceControlling && !this.remoteIsLite && !this.isTcpPair(pair);
```

That means the initial connectivity check itself carries `USE-CANDIDATE` for UDP / relay pairs.

When the first such check succeeds:

```ts
if (nominate || pair.remoteNominated) {
  pair.nominated = true;
}
...
this.checkComplete(pair);
```

and `checkComplete()` installs it as the selected pair only if `this.nominated == undefined`:

```ts
if (pair.nominated && ... && this.nominated == undefined) {
  this.nominated = pair;
  ...
}
```

After that, ICE processing for the component is completed and remaining waiting/frozen pairs are failed.

So for UDP / relay pairs the selected pair is effectively "first successful nominated check wins".

By contrast, TCP pairs already have a separate regular-nomination path (`nominateTcpPairIfReady()`) specifically so selection does not depend on which connectivity check happens to finish first.

The current changelog also explicitly notes that the TCP regular-nomination fix does not change UDP / relay nomination behavior.

## Why this is a problem

RFC 8445 §8.1.1 describes regular nomination:

1. allow connectivity checks to proceed until a stopping criterion is met;
2. choose one valid pair according to an evaluation criterion;
3. repeat the check for that chosen pair with `USE-CANDIDATE`.

It also notes that aggressive nomination was an RFC 5245 behavior and is no longer needed.

The current UDP / relay path instead sends `USE-CANDIDATE` during ordinary connectivity checks before a nomination decision has been made.

This matters especially with trickle ICE. A lower-priority candidate can arrive and succeed before a higher-priority candidate has even been signaled. Once the first pair is nominated, RFC 8445 does not permit nominating a different pair for the same component without ICE restart, so the correct fix is to avoid premature nomination rather than trying to switch pairs afterwards.

## Real-world impact

In mfarm-cloud:

- Chrome gathered relay candidates over both TURN/TCP and TURN/UDP.
- The lower-priority TCP-backed relay candidate completed first.
- werift nominated it immediately.
- A higher-priority UDP relay candidate was available shortly afterwards but could no longer become selected.
- A fixed ~4 Mbit/s video stream over TURN/TCP built up to ~6.2 s RTT.
- Forcing the UDP relay path reduced RTT to ~88 ms.

Another related observation in the same deployment was that when werift itself also had relay candidates, the first nominated relay pair could disagree with the path Chrome ended up using, causing video to freeze. Removing werift-side relay candidates avoided that failure.

## Expected behavior

For full ICE ↔ full ICE sessions, UDP / relay candidate pairs should use regular nomination as well:

- ordinary connectivity checks should not automatically carry `USE-CANDIDATE`;
- nomination should happen only after a stopping/evaluation criterion is met;
- the chosen pair should be selected deterministically from valid pairs according to candidate-pair priority / policy;
- trickled higher-priority candidates should have a chance to participate before nomination according to that stopping criterion;
- exactly one pair should be nominated for the component.

ICE-lite interoperability can keep its specialized behavior where required.

## Suggested implementation direction

Generalize the existing TCP regular-nomination machinery instead of maintaining a separate aggressive path for UDP:

- separate "connectivity check succeeded" from "nominate this pair";
- track valid succeeded pairs for all transports;
- introduce a trickle-aware nomination stopping criterion, for example:
  - remote end-of-candidates when available, and/or
  - a bounded nomination delay / policy hook for incremental trickle;
- choose the best valid pair once the criterion is met;
- send a dedicated `USE-CANDIDATE` check for that pair;
- preserve current ICE-lite handling;
- avoid renominating after a pair is successfully selected.

The exact stopping criterion is a policy decision; the important part is that ordinary UDP checks should not all be aggressive nomination checks.

## Regression tests

Please add tests covering at least:

1. Two UDP candidate pairs are present:
   - lower-priority pair succeeds first;
   - higher-priority pair succeeds later;
   - only the higher-priority valid pair is nominated.

2. Trickle ICE:
   - lower-priority relay candidate arrives and succeeds first;
   - higher-priority candidate is added shortly afterwards;
   - nomination is not irreversibly committed before the configured stopping criterion.

3. Only one viable candidate:
   - nomination still completes without unnecessary delay after end-of-candidates / stopping criterion.

4. Controlled / ICE-lite behavior remains unchanged.

5. No multiple `USE-CANDIDATE` nominations are emitted for the same component.

## Affected versions

Reproduced downstream with `werift 0.24.4`.

Current `develop` still contains the aggressive non-TCP nomination path described above, so this appears to remain applicable after 0.24.4.