[werift](../README.md) / [Exports](../modules.md) / FileIO

# Interface: FileIO

## Table of contents

### Properties

- [appendFile](FileIO.md#appendfile)
- [readFile](FileIO.md#readfile)
- [writeFile](FileIO.md#writefile)

## Properties

### appendFile

• **appendFile**: (`path`: `string`, `bin`: `BinaryLike`) => `Promise`<`void`\>

#### Type declaration

▸ (`path`, `bin`): `Promise`<`void`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `path` | `string` |
| `bin` | `BinaryLike` |

##### Returns

`Promise`<`void`\>

___

### readFile

• **readFile**: (`path`: `string`) => `Promise`<`Buffer`\>

#### Type declaration

▸ (`path`): `Promise`<`Buffer`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `path` | `string` |

##### Returns

`Promise`<`Buffer`\>

___

### writeFile

• **writeFile**: (`path`: `string`, `bin`: `BinaryLike`) => `Promise`<`void`\>

#### Type declaration

▸ (`path`, `bin`): `Promise`<`void`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `path` | `string` |
| `bin` | `BinaryLike` |

##### Returns

`Promise`<`void`\>
