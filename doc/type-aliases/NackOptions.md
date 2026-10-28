[**werift**](../README.md)

***

[werift](../globals.md) / NackOptions

# Type Alias: NackOptions

> **NackOptions** = `object`

Retry policy of the receiver-side generic NACK (RFC 4585).

The default (`{}`) keeps the legacy behavior: a lost packet is NACKed every
5ms and given up after 10 NACKs (about 50ms).

## Properties

### maxLost?

> `optional` **maxLost?**: `number`

Max lost packets tracked at the same time. Oldest are dropped. Default 150.

***

### maxWaitMs?

> `optional` **maxWaitMs?**: `number`

Latency budget in ms. A lost packet is NACKed until this much time has
passed since its loss was detected, then given up.
`0` disables NACK. When undefined, `retryCount` decides when to give up.

***

### retryCount?

> `optional` **retryCount?**: `number`

NACKs per lost packet before giving up when `maxWaitMs` is undefined. Default 10.

***

### retryIntervalMs?

> `optional` **retryIntervalMs?**: `number`

Interval in ms between NACKs for the same lost packet. Default 5.
