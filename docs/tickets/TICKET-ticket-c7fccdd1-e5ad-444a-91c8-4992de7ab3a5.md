## Summary

werift handles an incoming SCTP Outgoing SSN Reset Request immediately, even when DATA chunks up to the request's **Sender's Last Assigned TSN** have not all been received yet.

That lets a stream reset overtake a retransmitted DATA chunk. The inbound stream is deleted and the DataChannel is closed before the missing DATA arrives, so the retransmission is discarded and the final user message can be lost.

This is the RFC 6525 deferred-reset case.

## Evidence

A downstream interop test in `sidorares/react-x11-components#1154` reproduced this by intentionally dropping a chunk from the last DataChannel message:

https://github.com/sidorares/react-x11-components/pull/1154

The sender retransmits the missing chunk, but its Stream Reset can arrive first. The downstream workaround waits until all DATA on that SCTP stream is acknowledged before initiating close. That fixes the sender-controlled case, but it cannot protect werift when **the remote peer's** reset overtakes its own retransmission.

The downstream PR reports the deterministic failure as one complete 64 KiB message missing.

## Current werift behavior

This is still present in both **v0.25.2** and current `develop`.

`OutgoingSSNResetRequestParam` parses and exposes `lastTsn`:

```ts
constructor(
  public requestSequence: number,
  public responseSequence: number,
  public lastTsn: number,
  public streams: number[],
) {}
```

But `SCTP.receiveReconfigParam()` does not use `p.lastTsn`. It immediately:

1. sends `ReconfigResultSuccessPerformed`,
2. deletes the inbound stream(s),
3. emits `onReconfigStreams`.

Current code:

```ts
case OutgoingSSNResetRequestParam.type: {
  const p = param as OutgoingSSNResetRequestParam;

  const response = new ReconfigResponseParam(
    p.requestSequence,
    reconfigResult.ReconfigResultSuccessPerformed,
  );
  this.reconfigResponseSeq = p.requestSequence;
  await this.sendReconfigParam(response);

  await Promise.all(
    p.streams.map(async (streamId) => {
      delete this.inboundStreams[streamId];
      // ...
    }),
  );

  await this.transmitReconfigRequest();
  this.onReconfigStreams.execute(p.streams);
}
```

So `Sender's Last Assigned TSN` is currently informational only.

## Expected behavior

RFC 6525 requires deferred reset processing when the reset request refers to DATA that has not all arrived yet.

If the receiver has not processed all DATA up to `Sender's Last Assigned TSN`, it should defer performing the reset until the relevant TSN point has been reached rather than closing the inbound stream immediately.

The stream should therefore remain able to accept/reassemble retransmitted DATA that belongs before the reset boundary.

## Suggested implementation direction

- Track pending incoming reset requests whose `lastTsn` is ahead of the receiver's cumulative TSN state.
- Re-evaluate them when DATA / FORWARD-TSN advances the receive point.
- Only then:
  - reset/delete the affected inbound stream state,
  - emit `onReconfigStreams`,
  - return the appropriate reconfiguration response/result according to RFC 6525.
- Handle TSN wrap with the existing uint32 comparison helpers.
- Ensure duplicate/retransmitted reset requests remain idempotent.

## Regression test

A useful deterministic test would:

1. establish an SCTP association / DataChannel,
2. send a multi-chunk ordered message,
3. intentionally drop one DATA chunk,
4. deliver the sender's Outgoing SSN Reset Request before that chunk is retransmitted,
5. then deliver the missing retransmission,
6. assert that the complete message is delivered before the stream is closed/reset.

It would also be useful to cover:
- multiple streams in one reset request,
- TSN wrap,
- FORWARD-TSN / partial reliability,
- duplicate reset requests.

## Affected versions

Confirmed by source inspection in:
- `werift 0.25.2`
- current `develop` (including the upcoming v0.26.0 work at time of filing)

The v0.26.0 SCTP queue changes improve send/ACK scaling but do not implement deferred reset processing.