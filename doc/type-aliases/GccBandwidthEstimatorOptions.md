[**werift**](../README.md)

***

[werift](../globals.md) / GccBandwidthEstimatorOptions

# Type Alias: GccBandwidthEstimatorOptions

> **GccBandwidthEstimatorOptions** = `object`

Optional GCC constructor settings. Probe / RTT / process hooks are on
[BandwidthEstimator](../interfaces/BandwidthEstimator.md); this type is constructor-only (clock, ALR).

## Properties

### clock?

> `optional` **clock?**: [`GccClock`](GccClock.md)

Sender clock. Tests may inject a synthetic clock so send / feedback stay
in one domain. Production omits this (defaults to [milliTime](../variables/milliTime.md)).

***

### periodicAlrProbing?

> `optional` **periodicAlrProbing?**: `boolean`

pin `requests_alr_probing` / `ProbeController::EnablePeriodicAlrProbing`.
Default **false** — GoogCc does not enable periodic ALR probing after the
first TWCC; only an explicit config / this option turns it on.
