[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / SRTP\_REPLAY\_WINDOW\_SIZE

# Variable: SRTP\_REPLAY\_WINDOW\_SIZE

> `const` **SRTP\_REPLAY\_WINDOW\_SIZE**: `1024` = `1024`

RFC 3711 requires at least 64. Match libwebrtc (1024) so a NACK
retransmission of a lost packet still fits after the stream moved on.
