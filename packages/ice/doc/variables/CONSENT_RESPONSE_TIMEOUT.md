[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / CONSENT\_RESPONSE\_TIMEOUT

# Variable: CONSENT\_RESPONSE\_TIMEOUT

> `const` **CONSENT\_RESPONSE\_TIMEOUT**: `1000` = `1000`

Default single-shot response wait for consent requests (milliseconds) when pair
RTT is unknown. Consent uses `consentResponseTimeoutMs(pair.rtt)` which floors
at {@link CONSENT_RESPONSE_TIMEOUT_MIN} (500ms, RFC 8445) and estimates
`2×RTT + 200ms` when RTT is available.
