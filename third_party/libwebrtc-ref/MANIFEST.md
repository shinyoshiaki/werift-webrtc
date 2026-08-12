# libwebrtc reference snapshot (goog_cc subset)

**Not linked into builds or runtime.** Reference-only for GCC/TWCC BWE audits.

| Item | Value |
| --- | --- |
| Repository | https://webrtc.googlesource.com/src |
| Branch label | `main` |
| **Pinned commit** | `0fda16159e33adf59c71a7ad1173dcbe5a632102` |
| Pin date | 2026-08-11 |
| Re-fetch | `python3 third_party/libwebrtc-ref/fetch_ref.py` |
| Metadata | `PIN.json` |

Browse tree:

https://webrtc.googlesource.com/src/+/0fda16159e33adf59c71a7ad1173dcbe5a632102/modules/congestion_controller/goog_cc/

## Included paths

- `modules/congestion_controller/goog_cc/` — network control, delay BWE, trendline, inter-arrival, acked/robust throughput, loss-based V2, probe controller/estimator, **send_side_bandwidth_estimation, link_capacity_estimator** (RttBasedBackoff / IsRttAboveLimit / UpdatePropagationRtt)
- `modules/remote_bitrate_estimator/aimd_rate_control.{h,cc}`
- `modules/pacing/bitrate_prober.{h,cc}`
- `modules/congestion_controller/rtp/transport_feedback_{adapter,demuxer}.{h,cc}`

## Policy

1. Do **not** full-clone WebRTC; only the curated list in `fetch_ref.py`.
2. When reviewing werift GCC, use this pin only — do not mix unpinned web views.
3. When draft-ietf-rmcat-gcc and this pin diverge, **prefer this pin**.
4. After changing the pin: re-run `fetch_ref.py --commit <sha>`, update `PIN.json` and ticket tables together.
