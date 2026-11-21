[**werift**](../README.md)

***

[werift](../globals.md) / RECEIVING\_SWITCHING\_DELAY

# Variable: RECEIVING\_SWITCHING\_DELAY

> `const` **RECEIVING\_SWITCHING\_DELAY**: `1000` = `1000`

How long (ms) the selected pair must have stopped receiving (nothing
received for [WEAK\_CONNECTION\_RECEIVE\_TIMEOUT](WEAK_CONNECTION_RECEIVE_TIMEOUT.md)) before the
controlling agent fails over to a backup that receives, without waiting
for the selected pair to become unwritable. libwebrtc:
`receiving_switching_delay` (default 1000 ms).
