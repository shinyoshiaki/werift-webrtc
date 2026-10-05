[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpMediaClockResumeOptions

# Interface: RtpMediaClockResumeOptions

## Properties

### continuous?

> `optional` **continuous**: `boolean`

`false` (default): the paused wall-clock time is reflected as a timestamp
gap, the same as a scheduler stall.
`true`: the pause is collapsed and the timeline advances by one frame.
