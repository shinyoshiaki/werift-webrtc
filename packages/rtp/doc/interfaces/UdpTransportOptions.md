[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / UdpTransportOptions

# Interface: UdpTransportOptions

## Properties

### bindAddress?

> `optional` **bindAddress?**: `string`

Address the socket is bound to. Takes precedence over
`interfaceAddresses`; without either the socket binds the wildcard
address. An IPv6 link-local address needs its zone (`fe80::1%eth0`).

***

### interfaceAddresses?

> `optional` **interfaceAddresses?**: [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

***

### port?

> `optional` **port?**: `number`

***

### portRange?

> `optional` **portRange?**: \[`number`, `number`\]
