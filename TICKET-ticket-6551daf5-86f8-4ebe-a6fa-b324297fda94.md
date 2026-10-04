## Summary

A TURN relay candidate that finishes gathering after remote ICE candidates are already known is not paired with those remote candidates.

This is observable when signaling proceeds before TURN gathering completes (for example, sending an offer after the first host/srflx candidate). The session can then start ICE checks without the relay candidate, and when the TURN allocation completes later, that relay path is never checked.

A concrete downstream report is RelayMessenger/Relay-SDK#326:
https://github.com/RelayMessenger/Relay-SDK/pull/326

## Current behavior

In `packages/ice/src/ice.ts`, host UDP and active TCP local protocols explicitly pair themselves with already-known remote candidates:

```ts
this.protocols.push(protocol);
this.pairLocalProtocol(protocol);
this.appendLocalCandidate(protocol.localCandidate);
```

The TURN path does not:

```ts
this.ensureProtocol(protocol);
this.protocols.push(protocol);

// ... build relay candidate ...

this.appendLocalCandidate(protocol.localCandidate);
```

`addRemoteCandidate()` handles the opposite ordering by calling:

```ts
this.pairRemoteCandidate(remoteCandidate);
```

so "remote arrives after local" works, but "TURN local arrives after remote" does not.

There is also a scheduler lifetime concern: `connect()` / `schedulingChecks()` only waits for more *remote* candidates. If all currently formed pairs finish before TURN gathering completes, ICE may fail before the late local relay candidate can participate.

## Impact

This matters for trickle/early-signaling flows where TURN allocation is slower than host/srflx gathering.

Relay-SDK verified this limit against werift 0.24.4 while optimizing offer latency. Their production Cloudflare TURN allocation often finishes after the remote SFU answer is already available.

The result is that a valid relay route can exist but never receive a connectivity check in that ICE session.

## Expected behavior

When a new local protocol/candidate becomes available while remote candidates are already present:

1. form candidate pairs against compatible existing remote candidates;
2. add them to the checklist;
3. if ICE checking is active, ensure the new waiting pairs are actually scheduled;
4. do not fail the ICE session solely because current pairs are exhausted while local gathering is still in progress and can still add usable pairs.

## Suggested fix

At minimum, the TURN path should mirror host/TCP behavior:

```ts
this.protocols.push(protocol);
this.pairLocalProtocol(protocol);
this.appendLocalCandidate(protocol.localCandidate);
```

But a complete fix should also verify that a late local candidate can wake/extend the checklist while `connect()` is already running.

## Tests

Suggested regression cases:

- remote candidates added first, TURN candidate gathered later -> relay pair is created;
- ICE checks already running when TURN completes -> relay pair is checked;
- host/srflx pairs fail while TURN is still gathering -> connection waits for and succeeds via relay;
- relay candidate gathered before remote candidates -> existing behavior remains correct;
- end-of-remote-candidates does not incorrectly terminate checking while local gathering is still producing candidates.

Downstream evidence:
https://github.com/RelayMessenger/Relay-SDK/pull/326