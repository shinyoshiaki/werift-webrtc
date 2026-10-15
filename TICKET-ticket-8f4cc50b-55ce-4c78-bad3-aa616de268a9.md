## Summary

`UdpTransport` creates a Node/Bun dgram socket but installs no persistent `"error"` listener.

That means a runtime UDP socket error can surface as an uncaught EventEmitter error and terminate the worker/process instead of being handled by the transport/protocol layer.

This was reproduced independently in OpenClaw's werift-backed GPT-Live tests on Linux Bun:

https://github.com/openclaw/openclaw/pull/166465

After one peer intentionally closed, the surviving werift peer still had an in-flight RTP/RTCP send to the now-closed UDP port. Linux returned an ICMP port unreachable; Bun exposed it as:

```text
Error: recvmsg ECONNREFUSED
code: ECONNREFUSED
errno: -111
syscall: recvmsg
```

Because werift's `UdpTransport` had no socket `error` listener, the receiver worker threw. OpenClaw worked around it in the test harness by owning the worker error, but the underlying transport behavior remains.

## Current implementation

Current `develop`, `packages/common/src/transport.ts`:

```ts
private constructor(...) {
  this.socket = createSocket(socketType);
  this.socket.on("message", ...);
}
```

There is no:

```ts
this.socket.on("error", ...)
```

Node-style EventEmitters treat an emitted `error` event with no listener as an uncaught exception.

There is a second lifecycle concern during bind: `UdpTransport.init()` waits only for `"listening"`:

```ts
await new Promise((r) => this.socket.once("listening", r));
```

so a bind-time socket error can also bypass normal promise rejection unless another layer happens to intercept it.

## Why this matters

UDP errors are environment/runtime dependent:

- Linux connected/unconnected UDP + ICMP port-unreachable behavior
- Bun vs Node dgram behavior
- interface/address changes
- bind races / address availability
- local firewall/network changes

A transport library should not let an ordinary socket-level network error become an unowned process-level exception merely because the runtime emits it through the dgram `error` event.

## Expected behavior

`UdpTransport` should always own the socket `error` event.

The exact policy can differ by phase:

### During initialization/bind

A bind error should reject `UdpTransport.init()` cleanly and close the socket.

### During runtime

A socket error should be routed through an explicit transport error path rather than crashing the process.

Possible policies:

- expose an `onError` event/callback to the owning STUN/TURN/ICE layer;
- log and continue for recoverable asynchronous UDP errors such as a transient `ECONNREFUSED`;
- transition the owning protocol/ICE state when an error is transport-fatal.

The important invariant is that no dgram `error` event is left unhandled.

## Reproduction evidence

OpenClaw reproduced the primitive with two werift peers:

1. establish media;
2. close one peer;
3. let the surviving peer send/echo an in-flight RTP/RTCP packet to the closed port;
4. on Linux Bun `1.4.3-canary.1+667c4ab22`, `recvmsg ECONNREFUSED` was emitted by the dgram socket;
5. without a socket error listener, it propagated as an uncaught worker error.

They observed the real ICMP path in 2/3 runs and also forced the same socket error deterministically in their regression test.

The same script under Node 24 did not reproduce the kernel/runtime surface, but the missing listener exists in shared werift code and is therefore a portability/robustness issue.

## Suggested tests

Please add tests for:

1. `UdpTransport.init()` rejects cleanly on bind failure (for example, address/port already in use).
2. A runtime socket `error` event does not become an uncaught process exception.
3. `ECONNREFUSED` after the remote endpoint disappears is handled according to the chosen runtime policy.
4. Closing the transport after an error remains idempotent.
5. No double-settlement between `error`, `close`, and `listening`.
6. Node and Bun CI coverage if Bun is a supported/target runtime.

Related but distinct issues:

- #687: failed UDP TURN allocation leaks its socket
- #374: uncaught TURN transaction failure

This issue is specifically about ownership and propagation of the dgram socket's `error` event.