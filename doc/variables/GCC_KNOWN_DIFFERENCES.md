[**werift**](../README.md)

***

[werift](../globals.md) / GCC\_KNOWN\_DIFFERENCES

# Variable: GCC\_KNOWN\_DIFFERENCES

> `const` **GCC\_KNOWN\_DIFFERENCES**: readonly \[`"LossBasedBweV2: observation window, candidates, Newton inherent-loss update, and objective ranking ported; TCP-fairness upper bound omitted (optional Chromium path)"`, `"No REMB integration; TWCC-only send-side mode (ticket non-goal)"`, `"Probe pacing uses RTCRtpSender token-bucket + RTP padding injection (not webrtc::PacedSender)"`, `"Floating-point / wall-clock differences may cause sub-bps numerical drift vs C++"`\]

Intentional differences vs Chromium libwebrtc goog_cc.
Acceptable under the ticket's pure-TypeScript / no C++ binding constraint;
algorithm structure and control response match the reference.
