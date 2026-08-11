[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / createAv1AggregationHeader

# Function: createAv1AggregationHeader()

> **createAv1AggregationHeader**(`__namedParameters`): `Buffer`

Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4) with W=1.
N=1 and Z=1 must not both be set (deSerialize throws).

## Parameters

### \_\_namedParameters

#### endsWithFragment

`boolean`

#### startsNewCodedVideoSequence

`boolean`

#### startsWithFragment

`boolean`

## Returns

`Buffer`
