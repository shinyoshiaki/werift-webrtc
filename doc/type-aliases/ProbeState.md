[**werift**](../README.md)

***

[werift](../globals.md) / ProbeState

# Type Alias: ProbeState

> **ProbeState**: `"init"` \| `"waiting_for_result"` \| `"complete"`

libwebrtc ProbeController-aligned states:
- init: no probing initiated yet
- waiting_for_result: cluster(s) outstanding (queued and/or front active)
- complete: initial exponential probing finished
