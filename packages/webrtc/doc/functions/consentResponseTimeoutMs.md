[**werift**](../README.md)

***

[werift](../globals.md) / consentResponseTimeoutMs

# Function: consentResponseTimeoutMs()

> **consentResponseTimeoutMs**(`rttSeconds`?): `number`

Compute consent response wait from pair RTT (seconds).
Uses 2×RTT + 200ms jitter margin, floored at [CONSENT\_RESPONSE\_TIMEOUT\_MIN](../variables/CONSENT_RESPONSE_TIMEOUT_MIN.md).
Falls back to [CONSENT\_RESPONSE\_TIMEOUT](../variables/CONSENT_RESPONSE_TIMEOUT.md) when RTT is unavailable.

## Parameters

### rttSeconds?

`number`

## Returns

`number`
