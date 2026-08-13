[**werift**](../README.md)

***

[werift](../globals.md) / IntervalBudget

# Class: IntervalBudget

pin `modules/pacing/interval_budget` — byte budget used by AlrDetector.

Window is 500ms of the target rate. `canBuildUpUnderuse` (true for ALR)
lets unused budget accumulate up to that cap.

## Constructors

### new IntervalBudget()

> **new IntervalBudget**(`canBuildUpUnderuse`): [`IntervalBudget`](IntervalBudget.md)

#### Parameters

##### canBuildUpUnderuse

`boolean` = `true`

#### Returns

[`IntervalBudget`](IntervalBudget.md)

## Methods

### budgetRatio()

> **budgetRatio**(): `number`

#### Returns

`number`

***

### increaseBudget()

> **increaseBudget**(`deltaMs`): `void`

#### Parameters

##### deltaMs

`number`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### setTargetRateKbps()

> **setTargetRateKbps**(`kbps`): `void`

#### Parameters

##### kbps

`number`

#### Returns

`void`

***

### useBudget()

> **useBudget**(`bytes`): `void`

#### Parameters

##### bytes

`number`

#### Returns

`void`
