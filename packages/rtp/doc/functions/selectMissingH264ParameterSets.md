[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / selectMissingH264ParameterSets

# Function: selectMissingH264ParameterSets()

> **selectMissingH264ParameterSets**(`parameterSets`, `nalUnits`): `Buffer`\<`ArrayBufferLike`\>[]

From configured `parameterSets`, return only those whose type is not already
present in the sample (SPS and PPS checked independently).
E.g. sample with SPS-only → only missing PPS are returned.

## Parameters

### parameterSets

`Buffer`\<`ArrayBufferLike`\>[]

### nalUnits

`Buffer`\<`ArrayBufferLike`\>[]

## Returns

`Buffer`\<`ArrayBufferLike`\>[]
