[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpTimelineDropReason

# Enumeration: RtpTimelineDropReason

Why [RtpTimelineRewriter.rewrite](../classes/RtpTimelineRewriter.md#rewrite) dropped a packet.
- `staleSource`: the packet belongs to a source that was already replaced.
- `beforeSourceStart`: the packet is older (by sequence number) than the
  first packet of the current source, so its output would go back to or
  before the output of the previous source.

## Enumeration Members

### beforeSourceStart

> **beforeSourceStart**: `"beforeSourceStart"`

***

### staleSource

> **staleSource**: `"staleSource"`
