[**werift**](../README.md)

***

[werift](../globals.md) / ProbeClusterConfig

# Interface: ProbeClusterConfig

Probe cluster the sender should temporarily aim for (padding / encoder ramp).
GCC fires [BandwidthEstimator.onProbeClusterConfig](BandwidthEstimator.md#onprobeclusterconfig) with this payload;
legacy / disabled estimators never emit it.

## Properties

### id

> **id**: `number`

***

### minBytes

> **minBytes**: `number`

Minimum bytes expected for the cluster (for receive-ratio checks).

***

### minDurationMs

> **minDurationMs**: `number`

***

### minPackets

> **minPackets**: `number`

***

### minProbeDeltaMs

> **minProbeDeltaMs**: `number`

pin `ProbeClusterConfig.min_probe_delta` (ms). Used for
RecommendedMinProbeSize and stored on the BitrateProber cluster.

***

### requestedAtMs

> **requestedAtMs**: `number`

pin `requested_at` — queue age for the 5s queued-cluster timeout.

***

### targetBps

> **targetBps**: `number`

Target bitrate the pacer / sender should temporarily aim for (bps).
