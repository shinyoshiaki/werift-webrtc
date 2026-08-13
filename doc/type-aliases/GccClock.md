[**werift**](../README.md)

***

[werift](../globals.md) / GccClock

# Type Alias: GccClock()

> **GccClock**: () => `number`

Optional sender clock for tests. Production uses [milliTime](../functions/milliTime.md) so
`sendingAtMs` and TWCC feedback arrival share one domain (pin Timestamp).

## Returns

`number`
