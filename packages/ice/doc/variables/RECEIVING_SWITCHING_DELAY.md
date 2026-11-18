[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / RECEIVING\_SWITCHING\_DELAY

# Variable: RECEIVING\_SWITCHING\_DELAY

> `const` **RECEIVING\_SWITCHING\_DELAY**: `1000` = `1000`

A backup that wins over the selected pair only because the selection is not
receiving (nothing received for [WEAK\_CONNECTION\_RECEIVE\_TIMEOUT](WEAK_CONNECTION_RECEIVE_TIMEOUT.md))
takes over only once the selection has not been receiving for this long
(ms); the decision is checked again then, and a selection that received
something meanwhile stays. libwebrtc: `receiving_switching_delay`
(`kReceivingSwitchingDelay`).
