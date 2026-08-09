[**werift**](../README.md)

***

[werift](../globals.md) / GCC\_KNOWN\_DIFFERENCES

# Variable: GCC\_KNOWN\_DIFFERENCES

> `const` **GCC\_KNOWN\_DIFFERENCES**: readonly \[`"LossBasedBweV2: byte-loss objective/derivative (UseByteLossRate), bias adjustment by loss ratio, instant upper/lower bounds, delayed-increase window, HOLD rate; full ALR/padding-duration state machine simplified (IncreaseUsingPadding collapsed into increasing when padding path is unused)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender); initial 3x/6x clusters are multi-active (pacing target = max active)"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++"`, `"InterArrivalDelta: reordered-reset / arrival-offset thresholds ported; system-clock path omitted (TWCC receive times only)"`\]

Intentional differences vs Chromium libwebrtc goog_cc.
Acceptable under the ticket's pure-TypeScript / no C++ binding constraint;
algorithm structure and control response match the reference.
