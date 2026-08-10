[**werift**](../README.md)

***

[werift](../globals.md) / GCC\_KNOWN\_DIFFERENCES

# Variable: GCC\_KNOWN\_DIFFERENCES

> `const` **GCC\_KNOWN\_DIFFERENCES**: readonly \[`"LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD rate; full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal; future work)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); initial 3x/6x configs are created together (InitiateProbing) but paced FIFO (one front cluster; BitrateProber semantics); fill needs minBytes AND minPackets; ProbeBitrateEstimator-style min receive % / send-recv ratio / interval checks; recovery + 5s cooldown; abort on loss≥5% or overuse; no ALR-only probe path"`, `"AIMD: TimeToReduceFurther (RTT spacing + throughput check) and hold-after-decrease ported; RTT is estimated from feedback arrival − last send (not full ICE/STUN RTT stats / NetworkController RTT)"`, `"TWCC 24-bit reference_time is unwrapped across feedbacks in GccBandwidthEstimator (continuous ms timeline); packetResults alone still report raw wrap-relative times"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++ (not bit-identical to libwebrtc public test vectors)"`, `"InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)"`, `"Transport-wide sequence is shared on the DTLS transport while BWE instances are per RTCRtpSender (ticket constraint; multi-sender asymmetry is intentional)"`\]

Intentional differences vs Chromium libwebrtc goog_cc.
Acceptable under the ticket's pure-TypeScript / no C++ binding constraint;
algorithm structure and control response match the reference.
