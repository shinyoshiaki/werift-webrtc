[**werift**](../README.md)

***

[werift](../globals.md) / DTLS\_ALERT\_SEND\_TIMEOUT\_MS

# Variable: DTLS\_ALERT\_SEND\_TIMEOUT\_MS

> `const` **DTLS\_ALERT\_SEND\_TIMEOUT\_MS**: `100` = `100`

Upper bound (ms) for waiting until close_notify / a fatal alert has been
handed to ICE in [RTCDtlsTransport.stop](../classes/RTCDtlsTransport.md#stop); it adds directly to the
time `RTCPeerConnection.close()` takes.
