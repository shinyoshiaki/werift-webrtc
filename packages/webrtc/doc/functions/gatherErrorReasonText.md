[**werift**](../README.md)

***

[werift](../globals.md) / gatherErrorReasonText

# Function: gatherErrorReasonText()

> **gatherErrorReasonText**(`code`, `reason`, `response?`, `secrets?`): `string`

The `errorText` of a STUN / TURN error response (W3C: the reason text the
server returned), safe to hand to the application:

- every credential material werift knows is replaced by
  [MASKED\_REASON\_TEXT](../variables/MASKED_REASON_TEXT.md): what it sent (`secrets`: the TURN username
  and password) and what the response carries (USERNAME, REALM, NONCE);
- control characters are dropped and the text is cut to 127 characters
  (RFC 8489 §14.8);
- an empty result gives the registered phrase of the code
  (stunErrorReasonPhrase).

## Parameters

### code

`number`

### reason

`unknown`

### response?

[`Message`](../classes/Message.md)

### secrets?

readonly `string`[] = `[]`

## Returns

`string`
