[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / parseAvcDecoderConfigurationRecord

# Function: parseAvcDecoderConfigurationRecord()

> **parseAvcDecoderConfigurationRecord**(`description`): [`AvcDecoderConfigurationRecord`](../type-aliases/AvcDecoderConfigurationRecord.md)

Parse an avcC record (e.g. WebCodecs / mediabunny `decoderConfig.description`)
into the NAL length size and SPS/PPS NAL units (no length prefix).
Throws on a truncated record instead of returning partial parameter sets.

## Parameters

### description

`ArrayBufferLike` | `ArrayBufferView`\<`ArrayBufferLike`\>

## Returns

[`AvcDecoderConfigurationRecord`](../type-aliases/AvcDecoderConfigurationRecord.md)
