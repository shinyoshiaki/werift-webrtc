[**werift**](../README.md)

***

[werift](../globals.md) / GCC\_KNOWN\_DIFFERENCES

# Variable: GCC\_KNOWN\_DIFFERENCES

> `const` **GCC\_KNOWN\_DIFFERENCES**: readonly \[`"LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD (state stays decreasing while holdUntil active; ramp-up 1.2× when acked still below hold×1.3 else 1.5×); full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); 3x/6x queued FIFO — pacing advances on send-fill (minBytes AND minPackets), not on ACK; result clusters await TWCC separately; session complete deferred to process() so last-cluster setEstimatedBitrate can still enqueue further probes; when uncapped further/recovery target would exceed max_bitrate, one last max probe then min_bitrate_to_probe_further=+inf (no infinite max-bitrate padding); lifecycle/timeout/cooldown use sender clock only; onProbeClusterConfig fires on activate only; ProbeBitrateEstimator receive % / ratio checks; valid results always surfaced (lower probes floored at acked×0.85); recovery + 5s cooldown; abort on loss≥5% or overuse; no ALR-only probe path"`, `"AIMD: TimeToReduceFurther (RTT spacing + throughput check) and hold-after-decrease ported; RTT is estimated from feedback arrival − last send (not full ICE/STUN RTT stats / NetworkController RTT)"`, `"TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times; ReceiverTWCC late-reorder history is ~500ms (time-based) with a sequence safety bound"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)"`, `"InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)"`, `"Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)"`\]

Intentional differences vs Chromium libwebrtc goog_cc.
Acceptable under the ticket's pure-TypeScript / no C++ binding constraint;
algorithm structure and control response match the reference.
