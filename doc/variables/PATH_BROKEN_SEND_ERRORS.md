[**werift**](../README.md)

***

[werift](../globals.md) / PATH\_BROKEN\_SEND\_ERRORS

# Variable: PATH\_BROKEN\_SEND\_ERRORS

> `const` **PATH\_BROKEN\_SEND\_ERRORS**: `ReadonlySet`\<`string`\>

Send errors (`code` of the Node.js error) that say the path itself is
gone, not that a packet was lost: no route to the network or host, the
network or host is down, the local address went away, or a local firewall
refuses it. `Protocol.onPathBroken` reports them.
