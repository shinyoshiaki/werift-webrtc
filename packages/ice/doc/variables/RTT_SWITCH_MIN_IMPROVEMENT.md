[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / RTT\_SWITCH\_MIN\_IMPROVEMENT

# Variable: RTT\_SWITCH\_MIN\_IMPROVEMENT

> `const` **RTT\_SWITCH\_MIN\_IMPROVEMENT**: `10` = `10`

Between pairs of equal state and priority, the selection moves only to a
pair whose smoothed RTT ([CandidatePair.smoothedRtt](../classes/CandidatePair.md#smoothedrtt)) is at least this
much (ms) lower. libwebrtc: `kMinImprovement`.

## See

tests/ice/selection-controller.test.ts "equal priority: a pair only 9 ms faster does not take the selection"
