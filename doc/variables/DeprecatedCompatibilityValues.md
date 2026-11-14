[**werift**](../README.md)

***

[werift](../globals.md) / DeprecatedCompatibilityValues

# Variable: DeprecatedCompatibilityValues

> `const` **DeprecatedCompatibilityValues**: `object`

The values the compatibility options used up to v0.27.0 that are not
values any more, and the value each one is read as. They are accepted on
input only: `getConfiguration()` returns the current name.

## Type Declaration

### certificateScope

> `readonly` **certificateScope**: `object`

#### certificateScope.peerConnection

> `readonly` **peerConnection**: `"standard"` = `"standard"`

### keyFrameRequestRouting

> `readonly` **keyFrameRequestRouting**: `object`

#### keyFrameRequestRouting.compatible

> `readonly` **compatible**: `"fallback"` = `"fallback"`

#### keyFrameRequestRouting.strict

> `readonly` **strict**: `"standard"` = `"standard"`

### mLineReuse

> `readonly` **mLineReuse**: `object`

#### mLineReuse.compatible

> `readonly` **compatible**: `"standard"` = `"standard"`
