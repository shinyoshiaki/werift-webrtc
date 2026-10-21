[**werift**](../README.md)

***

[werift](../globals.md) / createAv1AggregationHeader

# Function: createAv1AggregationHeader()

> **createAv1AggregationHeader**(`__namedParameters`): `Buffer`

Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4).
W identifies the number of OBU elements (1..3); the final element has no length field.
N=1 and Z=1 must not both be set (deSerialize throws).

## Parameters

### \_\_namedParameters

#### endsWithFragment

`boolean`

#### obuCount?

`number` = `1`

W field: number of OBU elements (1..3); the last one has no length.

#### startsNewCodedVideoSequence

`boolean`

#### startsWithFragment

`boolean`

#### w?

`0` \| `2` \| `1` \| `3` = `1`

Number of OBU elements, or zero when each element has a length prefix.

## Returns

`Buffer`
