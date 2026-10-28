# Latency budget: "WebRTC is still the problem" reproduced with WebRTC

[WebRTC is still the problem](https://moq.dev/blog/webrtc-is-still-the-problem/)
(moq.dev, Voice AI: STT → LLM → TTS) lists what MoQ does better than WebRTC.
Most of the points come from the **default behavior of the browser's libwebrtc**
(NetEQ, playout by arrival time, audio NACK off), not from the RTP/RTCP
protocols. This example takes the encoded frames out **before NetEQ** with
Encoded Transform, plays them with its own player (WebCodecs `AudioDecoder` +
AudioWorklet), and lets werift handle long retransmissions. It shows which
parts the application and the server can fill in, and which parts are real
browser limits.
- `server.ts`: werift (WebSocket signaling on port 8888). Roles `publisher`
  (mic → werift, NACK within a budget, recorded to `latency-budget-*.webm`),
  `subscriber` (werift relay → browser, application-layer NACK over a
  DataChannel), `tts` (replays the last recording as the "AI answer").
- `index.html` / `main.ts`: the scenarios A–D. Results are shown on the page
  and kept in `window.__latencyBudgetResult`.
- `transform-worker.ts` / `encodedFrames.ts`: receiver transform
  (`RTCRtpScriptTransform`, or `createEncodedStreams()` as a fallback). Frames
  are copied out and passed on unchanged, so the native `<audio>` keeps
  playing them for comparison.
- `player.ts` / `player-worklet.js`: the player that replaces NetEQ.

## Run

```sh
# terminal 1 (repository root)
node --experimental-transform-types --import ./tools/node-ts/register.mjs \
  examples/mediachannel/latency_budget/server.ts

# terminal 2
cd examples/e2e && npm i && npx vite ../mediachannel/latency_budget
```

Open the Vite URL in Chrome and run the scenarios top to bottom (B and D
replay what A or C recorded). Use headphones (see "Limits").

| Scenario                       | What to do                                                      | What you see                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: reliable upstream           | `record` with budget `0`, then `5000`                           | werift `lost` / `recovered` / `unrecovered` under the same periodic burst loss. 0: everything lost stays lost. 5000: everything is recovered by audio NACK. Compare the two `.webm` files.                                                                                                                                                                                                         |
| B: faster-than-realtime answer | `speak` with pace `burst`, listen to `player`, then to `native` | The answer is sent in a few ms. The player plays it at RTP-timestamp speed; NetEQ (`native`) discards most of the burst (`packetsDiscarded`, `concealedSamples`). With pace `realtime` (sleep 20ms, what a WebRTC TTS server does today) NetEQ is fine.                                                                                                                                            |
| C: per-subscriber budget       | `start` (500ms / 5000ms)                                        | Same upstream and the same downstream burst loss for both. The 500ms subscriber conceals what it cannot recover within 500ms and keeps its delay ≤ 500ms; the 5000ms subscriber recovers everything with a larger delay. The upstream NACK budget follows the most patient subscriber.                                                                                                             |
| D: barge-in                    | `speak, then interrupt`                                         | The `interrupt now` button (or the automatic interrupt) flushes the player locally at once and tells werift, which stops sending, sends a `generation` control message and bumps the generation in the RTP CSRC. The old answer is dropped even if the new answer is delayed (`new answer delayed by`) or never comes (`flushedFrames`, `oldGenerationPlayed: 0`, no frames played while waiting). |

Verified with Chromium 156.0.8078.4 (Playwright, headless) on Linux,
2026-10. The smoke test is `examples/e2e/tests/mediachannel/latency_budget.test.ts`.

## Article claims and what this example does

| #             | Article: WebRTC weakness                                                 | MoQ                                                            | Here                                                                                                                                                                                                          | Where the gap is filled                                                                                                                   |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | Late audio is dropped                                                    | Retransmit as long as the consumer wants (e.g. 5s)             | A, C                                                                                                                                                                                                          | werift `nack: { maxWaitMs }`, player `maxDelayMs`                                                                                         |
| 2             | Audio NACK is off by default; with SDP munging NetEQ still does not wait | QUIC retransmission                                            | A: Chrome → werift with munged `a=rtcp-fb:<opus> nack` (Chrome answers NACKs for audio once negotiated). C: werift → Chrome with an application-layer NACK over a DataChannel and `RTCRtpSender.retransmit()` | Browser default (SDP), app + werift                                                                                                       |
| 3, 4          | NetEQ plays by arrival time; TTS must sleep before sending               | Send when ready, play by timestamp                             | B                                                                                                                                                                                                             | Encoded Transform + player                                                                                                                |
| 5, 10         | One latency setting per transport                                        | Max latency per subscription, fan-out of one upstream          | C                                                                                                                                                                                                             | Subscriber declares its budget over the DataChannel; werift cuts retransmission at it (`maxAgeMs`) and NACKs upstream for the largest one |
| 7             | playout-delay is video only                                              | Subscriber declares the max latency, the player buffers for it | Player `minDelayMs` / `maxDelayMs` per subscriber                                                                                                                                                             | Player (the receiver decides, unlike playout-delay where the sender does)                                                                 |
| 8             | (MoQ) bump the track generation to drop old buffers                      | New track, old one dropped                                     | D: generation in CSRC, visible as `getMetadata().contributingSources`                                                                                                                                         | In-band, no new RTP extension                                                                                                             |
| 6             | FEC / RED are weak against bursts                                        | Retransmit instead                                             | Not implemented (optional). The burst-loss debug model (`DebugConfig.*BurstLoss`) is there to compare RED and NACK                                                                                            | —                                                                                                                                         |
| 9, 11, 12, 13 | Governance, prioritized tracks, backfill, STS                            | —                                                              | Out of scope                                                                                                                                                                                                  | —                                                                                                                                         |

### Still browser limits (not reproduced)

- NetEQ itself is unchanged. The native `<audio>` path still plays by arrival
  time, discards bursts and does not wait for audio retransmissions. This
  example **bypasses NetEQ** with Encoded Transform and a custom player.
- playout-delay is not applied to native audio, and Encoded Transform metadata
  does not expose arbitrary RTP header extensions, so werift does not send
  the playout-delay extension. The budget is declared by the subscriber
  instead.
- Chrome does not NACK audio on the receive side unless the local SDP is
  munged, and then (per the article; not measured here) NetEQ's NackTracker
  stops asking once a packet is past its playout deadline. Scenario C
  therefore leaves `nack` out of the subscriber SDP and NACKs from the
  application.

## What the custom player takes over from NetEQ

| NetEQ                  | This player                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLC (loss concealment) | WebCodecs `AudioDecoder` does not expose Opus PLC. Holes are silence, with a short fade-in afterwards. Opus in-band FEC is not used.                                                                                |
| Time-stretch           | Only "skip silent frames" to shrink the delay back toward `minDelayMs`. A hole within the budget stalls playback (the delay grows); past `maxDelayMs` it is concealed and frames older than the budget are dropped. |
| Clock drift            | Handled by the same stall / silence-skip: the buffer grows or shrinks and the delay is pulled back during silence. No resampling.                                                                                   |
| Echo cancellation      | Whether Chrome's AEC uses WebAudio output as its reference depends on platform and version, and was not verified (headless, fake devices). With the mic open, use headphones.                                       |

Other simplifications: frames are placed by `getMetadata().rtpTimestamp` and
holes are found by `sequenceNumber` (without it, e.g. older Chrome, there is no
NACK); a gap of more than 200ms in RTP time is a new talk spurt and re-anchors
the playout.

## werift APIs used

- `PeerConfig.nack` / `RTCRtpReceiver.setNackOptions({ maxWaitMs, retryIntervalMs })`
  and `RTCRtpReceiver.nackStats`. Audio is NACKed when the codec negotiates
  `nack` (`useOPUS({ rtcpFeedback: [useNACK()] })`).
- `PeerConfig.rtpHistorySize` (rounded up to a power of two internally, so the ring stays consistent across the 16-bit sequence wrap) and `RTCRtpSender.retransmit(seqs, { maxAgeMs })`.
- `DebugConfig.inboundBurstLoss` / `outboundBurstLoss` (periodic, so the
  smoke test is deterministic).
- `RTCRtpSender.sendRtp()` keeps the CSRC list, and relaying an older
  (recovered) packet does not rewind the sender state.
