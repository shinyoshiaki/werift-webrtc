[**werift**](../README.md)

***

[werift](../globals.md) / ProbeState

# Type Alias: ProbeState

> **ProbeState**: `"init"` \| `"waiting_for_result"` \| `"complete"`

libwebrtc ProbeController-aligned states:
- init: no probing initiated yet
- waiting_for_result: pacing and/or awaiting-ACK clusters outstanding
- complete: initial exponential probing finished
