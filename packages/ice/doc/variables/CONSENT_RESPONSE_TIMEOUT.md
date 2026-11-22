[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / CONSENT\_RESPONSE\_TIMEOUT

# Variable: CONSENT\_RESPONSE\_TIMEOUT

> `const` **CONSENT\_RESPONSE\_TIMEOUT**: `1000` = `1000`

RTT-based response deadline of a consent request (ms) when the RTT is
unknown (see [consentResponseTimeoutMs](../functions/consentResponseTimeoutMs.md)). Downstream ICE-lite peers
typically answer in 150–300ms. It is no longer how long the request's
transaction stays open: that is [CONSENT\_TIMEOUT](CONSENT_TIMEOUT.md), so a response
after this deadline still refreshes the consent.
