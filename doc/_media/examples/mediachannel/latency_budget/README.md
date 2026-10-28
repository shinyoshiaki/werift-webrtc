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
- `vite.config.mts`: HTTPS on 0.0.0.0 with the signaling proxied (see "Open from another machine").
- `index.html` / `main.ts`: the scenarios A–D. Results are shown on the page
  and kept in `window.__latencyBudgetResult`.
- `transform-worker.ts` / `encodedFrames.ts`: receiver transform
  (`RTCRtpScriptTransform`, or `createEncodedStreams()` as a fallback). Frames
  are copied out and passed on unchanged, so the native `<audio>` keeps
  playing them for comparison.
- `sendGate.ts`: sender transform of the publisher (same worker, `{ side: "sender" }`).
  It reports the true send range by RTP timestamp; see "Accounting".
- `sendRange.ts`: werift side of that accounting. `webmFrames.ts`: reads the
  saved `.webm` back to check it.
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

### Open from another machine (e.g. a tailnet)

`vite.config.mts` serves the page on `0.0.0.0:5173` over **HTTPS**: off
`localhost`, Chrome only allows `getUserMedia`, AudioWorklet, WebCodecs and
Encoded Transform in a secure context. The werift signaling is proxied on the
same origin (`wss://<host>:5173/signaling` → `ws://127.0.0.1:8888`), so only
port 5173 (TCP) is needed for the page and the signaling. The server listens
on `0.0.0.0:8888` too, for plain-HTTP use.
- Certificate: by default a self-signed one is generated with `openssl` into
  `.cert/` (git-ignored; accept the browser warning once). For a trusted one
  on a tailnet, run `tailscale cert <machine>.<tailnet>.ts.net` and start Vite
  with `LATENCY_BUDGET_TLS_CERT=<crt> LATENCY_BUDGET_TLS_KEY=<key>`, then open
  `https://<machine>.<tailnet>.ts.net:5173/` (`*.ts.net` and IP hosts are
  allowed; more with `LATENCY_BUDGET_ALLOWED_HOSTS`).
- Media: werift advertises the addresses of the machine it runs on. If that
  machine is on the tailnet, nothing else is needed. If werift runs in a
  container whose addresses the tailnet cannot reach, publish a UDP port range
  and advertise the host's tailnet address:

  ```sh
  LATENCY_BUDGET_ICE_ADDRESSES=<host tailnet IP> \
  LATENCY_BUDGET_ICE_PORT_RANGE=40000-40100 \
  node --experimental-transform-types --import ./tools/node-ts/register.mjs \
    examples/mediachannel/latency_budget/server.ts
  # and publish 5173/tcp and 40000-40100/udp from the container
  ```

- Other settings: `LATENCY_BUDGET_HOST` / `LATENCY_BUDGET_PORT` (Vite),
  `LATENCY_BUDGET_SIGNALING` (proxy target), `LATENCY_BUDGET_HTTP=1` (plain
  HTTP, localhost only), `LATENCY_BUDGET_SIGNALING_HOST` /
  `LATENCY_BUDGET_SIGNALING_PORT` (werift).

| Scenario                       | What to do                                                      | What you see                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: reliable upstream           | `record` with budget `0`, then `5000`                           | werift `lost` / `recovered` / `unrecovered` under the same periodic burst loss, optionally with a lost head (`head loss`), a lost tail (`tail loss`) and a tail that reaches werift only after the stop (`hold the last … frames`). 0: everything lost stays lost. 5000: everything is recovered by audio NACK, head and tail included. `accounting` checks every packet against what the browser sent. Compare the two `.webm` files. |
| B: faster-than-realtime answer | `speak` with pace `burst`, listen to `player`, then to `native` | The answer is sent in a few ms. The player plays it at RTP-timestamp speed; NetEQ (`native`) discards most of the burst (`packetsDiscarded`, `concealedSamples`). With pace `realtime` (sleep 20ms, what a WebRTC TTS server does today) NetEQ is fine.                                                                                                                                                                                |
| C: per-subscriber budget       | `start` (500ms / 5000ms)                                        | Same upstream and the same downstream burst loss for both. `minDelay` is set per subscriber too (the two inputs), and shows up as `startDelayMs`, the delay when playback starts. The 500ms subscriber conceals what it cannot recover within 500ms and keeps its delay ≤ 500ms; the 5000ms subscriber recovers everything with a larger delay. The upstream NACK budget follows the most patient subscriber.                          |
| D: barge-in                    | `speak, then interrupt`                                         | The `interrupt now` button (or the automatic interrupt) flushes the player locally at once and tells werift, which stops sending, sends a `generation` control message and bumps the generation in the RTP CSRC. The old answer is dropped even if the new answer is delayed (`new answer delayed by`) or never comes (`flushedFrames`, `oldGenerationPlayed: 0`, no frames played while waiting).                                     |

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
  smoke test is deterministic) and `DebugConfig.inboundRtpDrop` (per sequence
  number: scenario A drops only the first transmission of the head / tail).
- `RTCRtpReceiver.markFirstSentSequence()` / `markLastSentSequence()`: the
  sender's range, so a lost head or tail is NACKed; `nackStats.late` counts a
  packet that arrives after being given up.
- `MediaRecorder({ jitterBuffer: { latency, startSequenceNumber } })`: the
  recording starts at the sender's first packet, not the first one received.
- `RTCRtpSender.sendRtp()` keeps the CSRC list, and relaying an older
  (recovered) packet does not rewind the sender state.

## Ordering and relay deadlines

- The recording uses `MediaRecorder({ jitterBuffer: { latency: budget } })`, so a packet recovered by NACK is written in sequence order.
- `player.ts` feeds Opus to `AudioDecoder` in sequence order (`decodeOrder.ts`): frames behind a hole wait until it is recovered or its deadline passes; a frame that arrives after that is dropped (`lateDroppedFrames`), never decoded out of order (`outOfOrderDecodedFrames` stays 0).
- The relay judges a packet by its media lag, not by the time it entered a send history: how late it is now against the best delay seen so far on the media clock (`liveEdge.ts`). Neither a quiet upstream nor a newer packet that itself arrives late makes an old retransmission look fresh. A packet recovered upstream after more than a subscriber's budget is not relayed to it (`skippedLate`), and the subscriber's NACKs for such packets are refused.
- werift relays to a subscriber only once its DTLS is up (a packet sent before never enters the send history and could not be retransmitted), and tells it the first packet relayed over the DataChannel (`start`). The player holds frames until then, so a loss of the very first packets is a hole it NACKs, not a later start.
- Without CSRC metadata the `generation` control message carries `firstTimestamp`, the first RTP timestamp of the new answer; frames before it are the old generation. Frames that arrive between the local interrupt and that message wait, then are decided.

- Wrapping RTP numbers are extended relative to the newest value seen
  (`unwrap.ts`), never compared with a fixed first value: the subscription
  start (`subscriptionStart.ts`), the accounting's frame index, the relay's
  media clock (`liveEdge.ts`) and the player's generation boundary stay right
  past half a wrap (16bit sequence numbers: ~11 minutes of 20ms audio).

## Accounting (scenario A)

Nothing about the send range is estimated:
- The sender metadata of Encoded Transform has no sequence number, but its
  `rtpTimestamp` is the one on the wire, and one 20ms Opus frame is one packet
  (+960 ticks, +1 seq). The publisher's sender transform (`sendGate.ts`) sends
  `start` with the first RTP timestamp as soon as the first frame passes, and,
  when it is closed, the first / last RTP timestamp and the number of frames.
  Frames after the close are dropped in the transform, so they are never sent.
- werift maps timestamps to sequence numbers with any one received packet and
  checks every other packet against that mapping (`sendRange.ts`). The head
  range goes to `markFirstSentSequence()` at the start, so a lost head is
  NACKed within the budget; the tail goes to `markLastSentSequence()` at the
  stop, so a lost tail, or one still in flight, is NACKed too. werift then
  waits until nothing is pending (bounded by the budget) before it closes the
  WebM and reports.
- `accounting` is `verified` only if every packet matched, and `balanced`
  only if every sent frame is counted exactly once: received (duplicates
  once), pending, or never received (`unrecovered - late`). If the mapping
  does not hold (DTX, another ptime, packets outside the range), it says
  `unverified` with the reasons instead of reporting numbers.
- `recording.webmInOrder` / `webmFrames`: the saved `.webm` is read back
  (`webmFrames.ts`, its SimpleBlocks in file order) and compared frame by
  frame with the received frames in sequence order. The recorder starts at
  the sender's first sequence number (`startSequenceNumber`), so a head
  recovered after later packets is written first.
- `recording.evicted` counts audio dropped from the "AI answer" kept for B / D
  (the newest 15s), so a cut answer is visible.

werift keeps the books open after its report: a frame that still arrives (for
example given up at budget 0, then sent late) is counted (`late`,
`arrivedAfterStop`) and the accounting is reported again.

The smoke test runs scenario A with a periodic loss by position in the stream
(15 of every 100 packets, `periodicLoss`; the timed burst could cover the
frames sent after the stop or not, depending on when the stop happens), a lost
head (8 packets), a lost tail (300ms) and the last 10 frames held until 1s
after the stop. For budget 0 and 5000ms it asserts `verified`, `balanced`,
`pending = 0`, also after the held frames have arrived (`afterLate`); budget 0
counts each of them as `late`. With 5000ms no loss is left and every frame is
in the `.webm` in order.
