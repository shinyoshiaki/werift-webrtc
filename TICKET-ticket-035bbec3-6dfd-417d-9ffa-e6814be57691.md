## Summary

ICE initialization currently uses synchronous `crypto.randomBytes()` for credentials, tie-breakers, and transaction IDs.

The synchronous Node.js crypto API can block the JavaScript main thread while the OS random source is servicing the request. This is normally very short, but the ICE construction path is latency-sensitive and should avoid an unbounded synchronous native wait where practical.

## Relevant code

### `packages/ice/src/helper.ts`

```ts
import { randomBytes } from "crypto";

export function randomString(length: number) {
  return randomBytes(length).toString("hex").substring(0, length);
}

export function randomTransactionId() {
  return randomBytes(12);
}
```

### `packages/ice/src/ice.ts`

`Connection` synchronously initializes random ICE state:

```ts
localUsername = randomString(4);
localPassword = randomString(22);
private readonly tieBreaker: bigint = randomBytes(8).readBigUInt64BE(0);
```

The constructor also calls `restart()`, which generates a new username/password again:

```ts
this.restart();
```

and `restart()` performs:

```ts
this.localUsername = randomString(4);
this.localPassword = randomString(22);
```

So creating an ICE `Connection` performs multiple synchronous random-source reads on the main JavaScript thread.

`randomTransactionId()` also uses synchronous `randomBytes(12)` and can be called repeatedly during STUN/TURN/ICE transactions.

## Why this matters

Unlike an awaited asynchronous operation, a synchronous native crypto call blocks the Node.js event loop until it returns. During that interval, JavaScript timers, socket handlers, HTTP handlers, and signal callbacks cannot execute.

Under normal operating conditions `randomBytes()` should complete quickly, so this is primarily a robustness issue rather than an expected common failure mode. However, ICE setup should not depend on an unbounded synchronous OS entropy read if an asynchronous or pre-generated alternative can be used.

## Proposed direction

Avoid synchronous entropy acquisition on the peer-connection / ICE initialization path.

Possible approaches:

### Option A: asynchronous ICE initialization

Introduce async random helpers based on the callback form of `crypto.randomBytes()` and generate ICE credentials/tie-breaker before constructing or starting the connection.

This is the strongest event-loop-safety option but may require broader API changes because `Connection` construction is currently synchronous.

### Option B: use WebCrypto for fixed-size random values

For small values such as ICE credentials, tie-breakers, and STUN transaction IDs, use `crypto.webcrypto.getRandomValues()` with fixed-size typed arrays and keep the random-generation logic centralized.

This keeps the public construction API synchronous while making the entropy primitive explicit and easier to test/replace. The implementation should confirm the runtime characteristics are suitable for the supported Node.js versions.

### Option C: pre-generate / pool entropy outside the critical path

Maintain a small random-value pool filled asynchronously and consume values synchronously during ICE construction. This avoids changing the existing `Connection` API while ensuring the critical path does not wait directly on OS entropy acquisition.

## Cleanup opportunity

The constructor currently initializes `localUsername` / `localPassword` at field declaration time and then immediately calls `restart()`, which regenerates both values.

That means the first credential pair is unused:

```ts
localUsername = randomString(4);
localPassword = randomString(22);
...
constructor(...) {
  ...
  this.restart();
}
```

At minimum, remove this duplicate random generation and let `restart()` perform the initial credential creation once.

## Test suggestions

- Verify constructor initialization only generates one ICE username/password pair.
- Make the random source injectable in unit tests and simulate a delayed/failing entropy provider.
- Add a regression test confirming ICE initialization does not introduce an avoidable synchronous entropy call on the critical path.
- Preserve the required randomness lengths/entropy for ICE credentials, tie-breaker, and STUN transaction IDs.