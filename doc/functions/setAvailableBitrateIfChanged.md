[**werift**](../README.md)

***

[werift](../globals.md) / setAvailableBitrateIfChanged

# Function: setAvailableBitrateIfChanged()

> **setAvailableBitrateIfChanged**(`target`, `nextBps`): `boolean`

Helper for concrete estimators: assign `availableBitrate` only when it changes
and notify `onAvailableBitrate` with the new value in bps.

## Parameters

### target

#### _availableBitrate

`number`

#### onAvailableBitrate

[`Event`](../classes/Event.md)\<\[`number`\]\>

### nextBps

`number`

## Returns

`boolean`
