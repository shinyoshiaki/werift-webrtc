[**werift**](../README.md)

***

[werift](../globals.md) / WeriftEventLike

# Interface: WeriftEventLike

The event object passed to the `on*` handlers of [MediaStreamTrack](../classes/MediaStreamTrack.md)
and [MediaStream](../classes/MediaStream.md). It is structural so that a DOM `Event` (and a DOM
`MediaStreamTrackEvent`) is assignable to it and a werift handler can be
typed by the DOM `onended` / `onaddtrack` types.

## Properties

### type

> `readonly` **type**: `string`
