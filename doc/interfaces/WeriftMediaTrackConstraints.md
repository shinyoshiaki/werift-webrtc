[**werift**](../README.md)

***

[werift](../globals.md) / WeriftMediaTrackConstraints

# Interface: WeriftMediaTrackConstraints

The constraints werift evaluates. `mimeType` is a werift extension that
selects a polyfill media register by the media it produces.

## Extends

- [`WeriftMediaTrackConstraintSet`](WeriftMediaTrackConstraintSet.md)

## Indexable

> \[`name`: `string`\]: `unknown`

Constraints werift cannot honor (`width`, `frameRate`, ...), as in the DOM
`MediaTrackConstraints`. A required one rejects `applyConstraints()`
with `OverconstrainedError`; an optional one is kept.

## Properties

### advanced?

> `optional` **advanced?**: [`WeriftMediaTrackConstraintSet`](WeriftMediaTrackConstraintSet.md)[]

***

### deviceId?

> `optional` **deviceId?**: [`WeriftConstrainDOMString`](../type-aliases/WeriftConstrainDOMString.md)

#### Inherited from

[`WeriftMediaTrackConstraintSet`](WeriftMediaTrackConstraintSet.md).[`deviceId`](WeriftMediaTrackConstraintSet.md#deviceid)

***

### groupId?

> `optional` **groupId?**: [`WeriftConstrainDOMString`](../type-aliases/WeriftConstrainDOMString.md)

#### Inherited from

[`WeriftMediaTrackConstraintSet`](WeriftMediaTrackConstraintSet.md).[`groupId`](WeriftMediaTrackConstraintSet.md#groupid)

***

### mimeType?

> `optional` **mimeType?**: [`WeriftConstrainDOMString`](../type-aliases/WeriftConstrainDOMString.md)

werift extension: the MIME type the source produces.

#### Inherited from

[`WeriftMediaTrackConstraintSet`](WeriftMediaTrackConstraintSet.md).[`mimeType`](WeriftMediaTrackConstraintSet.md#mimetype)
