[**werift**](../README.md)

***

[werift](../globals.md) / SentInfo

# Interface: SentInfo

Sent RTP packet observation used as input to send-side BWE algorithms.
Transport-wide sequence numbers come from the shared DTLS transport clock.

## Properties

### isProbation?

> `optional` **isProbation**: `boolean`

Optional flag for probe / probation packets used by some estimators (e.g. GCC).

***

### isRetransmission?

> `optional` **isRetransmission**: `boolean`

True when this packet is an RTX / retransmission.

***

### priorUnackedBytes?

> `optional` **priorUnackedBytes**: `number`

pin `SentPacket.prior_unacked_data` — untracked bytes attributed to
the next TWCC-tracked packet (RobustThroughputEstimator).

***

### probeClusterId?

> `optional` **probeClusterId**: `number`

pin `PacedPacketInfo.probe_cluster_id` reserved **before** send.
ProbeController must attribute this packet to this cluster, not
whatever is current when the async send completes.

***

### sendingAtMs

> **sendingAtMs**: `number`

Wall-clock send time in milliseconds.

***

### sentAtMs

> **sentAtMs**: `number`

Wall-clock time when the send completed in milliseconds.

***

### size

> **size**: `number`

Packet size in bytes (on-wire after SRTP when measured by the sender).

***

### wideSeq

> **wideSeq**: `number`
