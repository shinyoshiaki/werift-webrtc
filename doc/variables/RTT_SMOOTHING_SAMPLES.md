[**werift**](../README.md)

***

[werift](../globals.md) / RTT\_SMOOTHING\_SAMPLES

# Variable: RTT\_SMOOTHING\_SAMPLES

> `const` **RTT\_SMOOTHING\_SAMPLES**: `5` = `5`

The RTT samples [CandidatePair.smoothedRtt](../classes/CandidatePair.md#smoothedrtt) keeps (the most recent
ones); their median is the smoothed RTT, so a single outlier moves nothing.
werift's own value (libwebrtc keeps a moving average, ratio 3, which one
outlier still moves by a quarter of its distance).
