[**werift**](../README.md)

***

[werift](../globals.md) / RtpContinuityRewriterOptions

# Interface: RtpContinuityRewriterOptions

## Properties

### ssrc?

> `optional` **ssrc**: `number`

Output SSRC. Rewritten only when set; otherwise the input SSRC is kept.

***

### state?

> `optional` **state**: [`RtpContinuityState`](RtpContinuityState.md)

Restore a previous state to keep the output timeline continuous.
