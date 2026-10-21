[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / createAv1AggregationHeader

# Function: createAv1AggregationHeader()

> **createAv1AggregationHeader**(`__namedParameters`): `Buffer`

Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4). W defaults to 1;
W=0 means every OBU element has a length prefix.
N=1 and Z=1 must not both be set (deSerialize throws).

## Parameters

### \_\_namedParameters

#### endsWithFragment

`boolean`

#### startsNewCodedVideoSequence

`boolean`

#### startsWithFragment

`boolean`

#### w

`0 | 1 | 2 | 3`

Optional. Defaults to `1`. Use `0` when every OBU element has a length prefix.

## Returns

`Buffer`
