[**werift**](../README.md)

***

[werift](../globals.md) / createAlertRecord

# Function: createAlertRecord()

> **createAlertRecord**(`dtls`, `cipher`, `alert`): `Buffer`\<`ArrayBuffer`\>

Serialize an alert record protected with the current write epoch: plaintext
at epoch 0 (before ChangeCipherSpec), encrypted at epoch > 0. It shares the
epoch and the record sequence number with application data.

## Parameters

### dtls

`DtlsContext`

### cipher

[`CipherContext`](../classes/CipherContext.md)

### alert

[`DtlsAlert`](../interfaces/DtlsAlert.md)

## Returns

`Buffer`\<`ArrayBuffer`\>
