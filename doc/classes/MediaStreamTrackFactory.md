[werift](../README.md) / [Exports](../modules.md) / MediaStreamTrackFactory

# Class: MediaStreamTrackFactory

## Table of contents

### Constructors

- [constructor](MediaStreamTrackFactory.md#constructor)

### Methods

- [rtpSource](MediaStreamTrackFactory.md#rtpsource)

## Constructors

### constructor

• **new MediaStreamTrackFactory**(): [`MediaStreamTrackFactory`](MediaStreamTrackFactory.md)

#### Returns

[`MediaStreamTrackFactory`](MediaStreamTrackFactory.md)

## Methods

### rtpSource

▸ **rtpSource**(`«destructured»`): `Promise`\<readonly [[`MediaStreamTrack`](MediaStreamTrack.md), `number`, () => `void`]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `«destructured»` | `Object` |
| › `kind` | ``"audio"`` \| ``"video"`` |
| › `port?` | `number` |

#### Returns

`Promise`\<readonly [[`MediaStreamTrack`](MediaStreamTrack.md), `number`, () => `void`]\>
