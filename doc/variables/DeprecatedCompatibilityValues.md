[**werift**](../README.md)

***

[werift](../globals.md) / DeprecatedCompatibilityValues

# Variable: DeprecatedCompatibilityValues

> `const` **DeprecatedCompatibilityValues**: `object`

The values the compatibility options used up to v0.27.0, and the
[CompatibilityMode](../type-aliases/CompatibilityMode.md) each one is read as. They are accepted on input
only: `getConfiguration()` returns the new name.

## Type Declaration

### certificateScope

> `readonly` **certificateScope**: `object`

#### certificateScope.peerConnection

> `readonly` **peerConnection**: `"standard"` = `"standard"`

#### certificateScope.process

> `readonly` **process**: `"legacy"` = `"legacy"`

### keyFrameRequestRouting

> `readonly` **keyFrameRequestRouting**: `object`

#### keyFrameRequestRouting.compatible

> `readonly` **compatible**: `"legacy"` = `"legacy"`

#### keyFrameRequestRouting.strict

> `readonly` **strict**: `"standard"` = `"standard"`

### mLineReuse

> `readonly` **mLineReuse**: `object`

#### mLineReuse.aggressive

> `readonly` **aggressive**: `"legacy"` = `"legacy"`

#### mLineReuse.compatible

> `readonly` **compatible**: `"standard"` = `"standard"`
