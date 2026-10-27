[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / AvcDecoderConfigurationRecord

# Type Alias: AvcDecoderConfigurationRecord

> **AvcDecoderConfigurationRecord** = `object`

## Properties

### naluLengthSize

> **naluLengthSize**: `number`

lengthSizeMinusOne + 1: NAL length field size of AVCC samples (1, 2 or 4).

***

### parameterSets

> **parameterSets**: `Buffer`[]

SPS followed by PPS, ready for H264PacketizerOptions.parameterSets.

***

### pps

> **pps**: `Buffer`[]

***

### sps

> **sps**: `Buffer`[]
