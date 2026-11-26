[**werift**](../README.md)

***

[werift](../globals.md) / RTT\_SMOOTHING\_SAMPLES

# Variable: RTT\_SMOOTHING\_SAMPLES

> `const` **RTT\_SMOOTHING\_SAMPLES**: `5` = `5`

The RTT samples [CandidatePair.smoothedRtt](../classes/CandidatePair.md#smoothedrtt) keeps (the most recent
ones). werift's own value: libwebrtc keeps a moving average instead, which
one outlier still moves.

## See

tests/ice/selection-controller.test.ts "the median of the last 5 samples: one outlier does not move it"
