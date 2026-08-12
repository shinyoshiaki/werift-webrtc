[**werift**](../README.md)

***

[werift](../globals.md) / kRttBasedBackOffHighRttMs

# Variable: kRttBasedBackOffHighRttMs

> `const` **kRttBasedBackOffHighRttMs**: `3000` = `3_000`

RTT threshold used with GetBandwidthLimitedCause (pin goog_cc_network_control):
when IsRttAboveLimit is true, cause becomes kRttBasedBackOffHighRtt and
ProbeController::InitiateProbing returns no clusters.
Default 3s matches the common WebRTC-Bwe-MaxRttLimit field-trial default;
send_side_bandwidth_estimation (rate ×0.8 drop) is **not** in this pin set,
so high RTT only forbids probes — it does not force target bitrate drops.
