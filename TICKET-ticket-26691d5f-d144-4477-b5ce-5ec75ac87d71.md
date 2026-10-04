## Summary

The fMP4 muxer can enter an infinite loop when a video track does not provide `width` and/or `height` metadata.

## Reproduction

A downstream user (`sergio-pulido/reverie`) reproduced this while muxing H.264 RTP into fMP4 using werift 0.24.4.

The failure happens when processing the first complete H.264 keyframe:

```
computeRatio(track.width!, track.height!)
  -> gcd(width, height)
```

`Track.width` and `Track.height` are optional, so values can be `undefined` at runtime.

With both values undefined:

```
gcd(undefined, undefined)
```

causes:

```ts
while (y !== 0) {
  ...
}
```

to never terminate because `undefined % undefined` becomes `NaN` and `NaN !== 0` is always true.

## Impact

- fMP4 muxing never completes
- no init segment/media segment is produced
- recording pipelines can hang indefinitely
- Node.js event loop can be blocked

## Expected behavior

Invalid or missing video dimensions should not cause an infinite loop. Possible approaches:

- return a safe default ratio when dimensions are unavailable
- skip aspect-ratio calculation
- validate dimensions before calling gcd

## Additional notes

The public type already allows optional dimensions:

```ts
width?: number;
height?: number;
```

Therefore the runtime path should handle missing values safely.

A regression test should cover:

- H.264 keyframe processing
- fMP4 muxing with undefined width/height
- ensuring muxing fails gracefully or continues without hanging

Related downstream reproduction:
- https://github.com/sergio-pulido/reverie/pull/22