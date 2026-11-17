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

`IP4` / `IP6` の後ろのアドレスは文字列のまま受理する (ホスト名も可)。
addrtype は `addrType` として返すので、[rtcpAttributeToSdp](rtcpAttributeToSdp.md) に渡せば
元の addrtype のまま再出力できる。

## Parameters

### value

`string`

## Returns

`object`

### addrType?

> `optional` **addrType?**: `"IP4"` \| `"IP6"`

### host?

> `optional` **host?**: `string`

### port

> **port**: `number`
