[**werift**](../README.md)

***

[werift](../globals.md) / IceFailoverOptions

# Interface: IceFailoverOptions

Thresholds of the failover of the selected pair ([IceOptions.failover](IceOptions.md#failover)),
after libwebrtc's `RTCConfiguration` fields of the same meaning. Lower
values fail over sooner and also on a shorter loss burst.

## Properties

### receivingSwitchingDelay?

> `optional` **receivingSwitchingDelay?**: `number`

Time (ms) the selected pair must have stopped receiving (one of its
checks unanswered as well) before the controlling agent fails over to a
backup that receives, before the selected pair becomes unwritable. At
least 0; defaults to [RECEIVING\_SWITCHING\_DELAY](../variables/RECEIVING_SWITCHING_DELAY.md) (1000).
libwebrtc: `receiving_switching_delay`.

***

### receivingTimeout?

> `optional` **receivingTimeout?**: `number`

Time (ms) without receiving anything (response, request or data) after
which a pair is weak (checked at the weak interval, 900 ms) and stops
receiving. Greater than 0; defaults to
[WEAK\_CONNECTION\_RECEIVE\_TIMEOUT](../variables/WEAK_CONNECTION_RECEIVE_TIMEOUT.md) (2500). libwebrtc:
`receiving_timeout`.

***

### unwritableMinChecks?

> `optional` **unwritableMinChecks?**: `number`

Consecutive unanswered checks after which a pair is unwritable (together
with `unwritableTimeout`). An integer of at least 1; defaults to
[CONNECTION\_WRITE\_CONNECT\_FAILURES](../variables/CONNECTION_WRITE_CONNECT_FAILURES.md) (5). libwebrtc:
`ice_unwritable_min_checks`.

***

### unwritableTimeout?

> `optional` **unwritableTimeout?**: `number`

Time (ms) since a pair's last response after which it is unwritable
(together with `unwritableMinChecks`). At least 0; defaults to
[CONNECTION\_WRITE\_CONNECT\_TIMEOUT](../variables/CONNECTION_WRITE_CONNECT_TIMEOUT.md) (5000). libwebrtc:
`ice_unwritable_timeout`.
