[**werift**](../README.md)

***

[werift](../globals.md) / RtpMediaClockResumeOptions

# Interface: RtpMediaClockResumeOptions

## Properties

### continuous?

> `optional` **continuous**: `boolean`

`false`: the paused wall-clock time is reflected as a timestamp gap, the
same as a scheduler stall.
`true`: the pause is collapsed and the timeline advances by one frame.

Default: `false` for `stallPolicy: "skip"`, `true` for `"delay"`.
