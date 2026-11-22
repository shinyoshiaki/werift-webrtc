[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / consentResponseTimeoutMs

# Function: consentResponseTimeoutMs()

> **consentResponseTimeoutMs**(`rttSeconds?`): `number`

RTT-based response deadline (ms) from a pair RTT (seconds): when a consent
request without a response counts as unanswered (failover's pacing and
writability), and the response timeout of a backup check once the backup's
RTT is known. Uses 2×RTT + 200ms jitter margin, floored at
[CONSENT\_RESPONSE\_TIMEOUT\_MIN](../variables/CONSENT_RESPONSE_TIMEOUT_MIN.md). Falls back to
[CONSENT\_RESPONSE\_TIMEOUT](../variables/CONSENT_RESPONSE_TIMEOUT.md) when RTT is unavailable.

A consent request's transaction is not ended at this deadline: it stays
open for [CONSENT\_TIMEOUT](../variables/CONSENT_TIMEOUT.md), so a response slower than the estimate
(an RTT that rose after the selection) still refreshes the consent.

## Parameters

### rttSeconds?

`number`

## Returns

`number`
