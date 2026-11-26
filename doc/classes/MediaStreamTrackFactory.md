[**werift**](../README.md)

***

[werift](../globals.md) / MediaStreamTrackFactory

# Class: MediaStreamTrackFactory

## Constructors

### Constructor

> **new MediaStreamTrackFactory**(): `MediaStreamTrackFactory`

#### Returns

`MediaStreamTrackFactory`

## Methods

### rtpSource()

> `static` **rtpSource**(`__namedParameters`): `Promise`\<readonly \[[`MediaStreamTrack`](MediaStreamTrack.md)\<`"audio"` \| `"video"`\>, `number`, () => `void`\]\>

#### Parameters

##### \_\_namedParameters

###### cb?

(`buf`) => `Buffer`

###### kind

`"audio"` \| `"video"`

###### port?

`number`

#### Returns

`Promise`\<readonly \[[`MediaStreamTrack`](MediaStreamTrack.md)\<`"audio"` \| `"video"`\>, `number`, () => `void`\]\>
