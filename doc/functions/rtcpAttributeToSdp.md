[**werift**](../README.md)

***

[werift](../globals.md) / rtcpAttributeToSdp

# Function: rtcpAttributeToSdp()

> **rtcpAttributeToSdp**(`__namedParameters`): `string`

`a=rtcp` の値 (`a=rtcp:` 以降) を生成する (RFC 3605 §2.1)。
`host` が `undefined` の場合はアドレス省略形 `<port>` を出力する。
`addrType` を省略した場合は `host` が IPv4 リテラルなら `IP4`、それ以外は `IP6` とする。

## Parameters

### \_\_namedParameters

#### addrType?

`"IP4"` \| `"IP6"`

#### host?

`string`

#### port

`number`

## Returns

`string`
