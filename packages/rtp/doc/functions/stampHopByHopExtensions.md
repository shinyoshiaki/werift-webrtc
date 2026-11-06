[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / stampHopByHopExtensions

# Function: stampHopByHopExtensions()

> **stampHopByHopExtensions**(`header`, `negotiated`, `__namedParameters`): `number` \| `undefined`

Write the send-time values of the hop-by-hop extensions right before the
DTLS write: a newly allocated transport-wide sequence (when TWCC is on) and
the abs-send-time of `ntpTimestamp`.

## Parameters

### header

[`RtpHeader`](../classes/RtpHeader.md)

### negotiated

[`NegotiatedHeaderExtension`](../type-aliases/NegotiatedHeaderExtension.md)[]

### \_\_namedParameters

#### allocateTransportWideSequence

() => `object`

#### ntpTimestamp

`bigint`

#### twccOn

`boolean`

## Returns

`number` \| `undefined`

the extended transport-wide sequence, or undefined without TWCC.
