[**werift**](../README.md)

***

[werift](../globals.md) / negotiateRemoteCodecs

# Function: negotiateRemoteCodecs()

> **negotiateRemoteCodecs**(`localCodecs`, `remoteMedia`): [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

Remote codecs of an m-line that local codecs support. RTX is kept only when
the codec its `apt` names is kept too. Pre-validation and application use
the same rule, so an m-line that negotiates nothing is rejected up front.

## Parameters

### localCodecs

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

### remoteMedia

[`MediaDescription`](../classes/MediaDescription.md)

## Returns

[`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]
