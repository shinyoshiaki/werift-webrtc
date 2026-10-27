[**werift**](../README.md)

***

[werift](../globals.md) / RtpMediaPacerFrameTiming

# Interface: RtpMediaPacerFrameTiming

## Properties

### dts?

> `optional` **dts**: `number`

Decode time in `clockRate` units; frames are paced by it and must be pushed
in non-decreasing `dts` order. Default: `pts` (no B-frames).

***

### pts

> **pts**: `number`

Presentation time in `clockRate` units (e.g. container PTS rescaled to
90 kHz). Becomes the RTP timestamp. May be fractional.
