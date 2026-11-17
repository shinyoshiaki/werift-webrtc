[**werift**](../README.md)

***

[werift](../globals.md) / rtcpAttributeFromSdp

# Function: rtcpAttributeFromSdp()

> **rtcpAttributeFromSdp**(`value`): `object`

`a=rtcp` の値 (`a=rtcp:` 以降) をパースする (RFC 3605 §2.1)。

`rtcp-attribute = "a=rtcp:" port [nettype space addrtype space connection-address]`

- `<port>`: アドレス省略形。`host` は `undefined` (c= を継承する)
- `<port> IN IP4|IP6 <address>`: アドレス付き形式

port は 1–65535 の 10 進数でなければならず、それ以外の形式はエラーにする。

## Parameters

### value

`string`

## Returns

`object`

### host?

> `optional` **host?**: `string`

### port

> **port**: `number`
