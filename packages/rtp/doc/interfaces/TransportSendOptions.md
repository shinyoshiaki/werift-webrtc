[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / TransportSendOptions

# Interface: TransportSendOptions

Options of one `Transport.send`.

## Properties

### confirm?

> `optional` **confirm?**: `boolean`

Datagram transports: wait until the OS took the datagram and reject with
its error (`ENETUNREACH`, `EADDRNOTAVAIL`, ...). Without it a datagram to
an IP address is sent without a completion callback (faster per packet)
and a send error is not reported. Stream transports always report write
errors.
