# pion-webrtc-sped

A Pion PeerConnection with SPED on (pion/webrtc#3362, not released yet),
driven over JSON lines on stdin / stdout. werift's opt-in interop test
`tests/integrate/sped-pion-webrtc.test.ts` uses it to connect werift
`sped: true` to Pion SPED in both offer directions. The protocol is described
at the top of `main.go`.

## Build

```sh
# from packages/webrtc/tools/pion-webrtc-sped (needs Docker; no local Go)
./build.sh                 # → ./pion-webrtc-sped
./build.sh /tmp/pion-webrtc-sped
```

`build.sh` clones `fippo/pion-webrtc` at the pinned commit of the
pion/webrtc#3362 branch (override with `PION_WEBRTC_SPED_SHA`), replaces
`github.com/pion/webrtc/v5` with it and builds in a `golang:1.24` container.

## Run the test

```sh
cd ../..   # packages/webrtc
WERIFT_PION_WEBRTC_SPED="$(pwd)/tools/pion-webrtc-sped/pion-webrtc-sped" npm run test:pion-webrtc-sped
```

Default `npm test` skips the test; `npm run test:pion-webrtc-sped` fails when
`WERIFT_PION_WEBRTC_SPED` is not set.
