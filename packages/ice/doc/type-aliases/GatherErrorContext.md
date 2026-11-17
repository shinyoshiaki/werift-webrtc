[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / GatherErrorContext

# Type Alias: GatherErrorContext

> **GatherErrorContext** = `object`

The STUN/TURN stage of the gathering the error came from.

## Properties

### kind

> **kind**: `"stun"` \| `"turn"`

***

### secrets?

> `optional` **secrets?**: readonly `string`[]

Credential material the agent sent the server (a TURN username and
password), masked out of the server's reason phrase (see
gatherErrorReasonText).

***

### transport?

> `optional` **transport?**: `"udp"` \| `"tcp"` \| `"tls"`

Transport toward the server (TURN); STUN queries are UDP.
