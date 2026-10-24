[**werift**](../README.md)

***

[werift](../globals.md) / kTwccFeedbackHistoryMaxSeqSpan

# Variable: kTwccFeedbackHistoryMaxSeqSpan

> `const` **kTwccFeedbackHistoryMaxSeqSpan**: `32768` = `0x8000`

History span limit in extended transport-wide sequence numbers.

Every key kept in history lies in `(latestSent - span, latestSent]`. With a
span below half of the 16-bit space, a 16-bit feedback number maps onto at
most one history entry, and the nearest-generation unwrap cannot pick the
wrong one.
