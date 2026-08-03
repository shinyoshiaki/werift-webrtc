## Motivation

The RTP package is useful outside browser-to-browser WebRTC, including SIP gateways, RTSP cameras, media relays, and recording pipelines. Several commonly encountered RTP payload formats are not currently available as reusable packetizer/depacketizer implementations.

## Proposal

Add packetizer and depacketizer support for:

- H.265 / HEVC according to RFC 7798, including single NAL units, aggregation packets, and fragmentation units.
- G.711 PCMU and PCMA according to RFC 3551.
- G.722, including the RTP 8 kHz clock-rate rule.
- AAC-hbr according to RFC 3640.
- RFC 4733 named telephone events as a lower-level RTP primitive.

The APIs should follow the existing codec module conventions and support both direct class construction and generic codec-driven pipelines where appropriate.

## Acceptance criteria

- Each codec has packetization and depacketization tests using known wire-format vectors.
- H.265 supports Annex-B and length-prefixed input where practical, plus AP and FU handling.
- AAC supports AU headers and fragmentation of access units larger than the configured MTU.
- Static payload types and clock rates for PCMU, PCMA, and G.722 are represented correctly.
- Malformed payloads fail predictably without unbounded allocation.
- Sequence number, timestamp, marker, and MTU behavior are consistent with existing packetizers.
- Public exports and API documentation list all newly supported codecs.
- At least one integration example demonstrates a non-WebRTC RTP use case such as RTSP/SIP ingest or plain RTP-over-UDP.