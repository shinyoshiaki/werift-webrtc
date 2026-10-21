[**werift**](../README.md)

***

[werift](../globals.md) / createAv1AggregationHeader

# Function: createAv1AggregationHeader()

> **createAv1AggregationHeader**(`__namedParameters`): `Buffer`

Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4).
W defaults to 1; W=0 means every OBU element has a length prefix.
N=1 and Z=1 must not both be set (deSerialize throws).

## Parameters

### \_\_namedParameters

#### endsWithFragment

`boolean`

#### startsNewCodedVideoSequence

`boolean`

#### startsWithFragment

`boolean`

#### w?

`0` \| `2` \| `1` \| `3` = `1`

Number of OBU elements, or zero when each element has a length prefix.

## Returns

`Buffer`
