[**werift**](../README.md)

***

[werift](../globals.md) / BACKUP\_UNKNOWN\_RTT\_RESPONSE\_TIMEOUT

# Variable: BACKUP\_UNKNOWN\_RTT\_RESPONSE\_TIMEOUT

> `const` **BACKUP\_UNKNOWN\_RTT\_RESPONSE\_TIMEOUT**: `3000` = `3000`

Response timeout (ms) of a backup check while the pair's RTT is still
unknown (it never answered a check of this agent). libwebrtc starts a
connection's RTT estimate at `DEFAULT_RTT` (3000 ms); the consent default
([CONSENT\_RESPONSE\_TIMEOUT](CONSENT_RESPONSE_TIMEOUT.md), 1 s) would never let a backup path
slower than that become valid. Once the pair answered, the timeout follows
its RTT ([consentResponseTimeoutMs](../functions/consentResponseTimeoutMs.md)).
