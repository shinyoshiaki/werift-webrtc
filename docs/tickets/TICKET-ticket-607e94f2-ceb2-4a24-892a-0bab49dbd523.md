## Summary

When `MediaRecorder` (WebM writer, NTP time + lip sync enabled — the default) records an audio+video track pair, media received before the first RTCP Sender Report of each track does not make it into the file. In practice the head of the recording is lost: roughly the first ~0.5 s of video and ~2 s of audio in our E2E runs with Chrome.

## Observed

Found while adding the record → DataChannel → browser playback E2E test (`e2e/tests/mediachannel/recordPlayback.test.ts`, `av` case; Chrome fake camera, browser is the offerer, 5 s recording).

- After fixing `ntpTime2Sec` (NTP fraction was parsed as a decimal fraction instead of `/ 2^32`), recordings are otherwise stable, but the recorded duration is consistently shorter than the wall-clock recording time.
- The missing part is the beginning: the media sent before each track's first SR (≈0.5 s video, ≈2 s audio in the observed runs).
- The test currently tolerates this by only requiring `duration > recording time / 2`.

## Likely cause (needs confirmation)

Pipeline in `packages/webrtc/src/nonstandard/recorder/writer/webm.ts`: `NtpTimeCallback` → `DepacketizeCallback` → `LipsyncCallback` → `WebmCallback`.

1. `NtpTimeBase` (`packages/rtp/src/extra/processor/ntpTime.ts`) cannot assign a time until the track receives its first SR, so RTP is buffered per track until then. Audio and video SRs arrive at different moments.
2. `LipsyncBase` (`packages/rtp/src/extra/processor/lipsync.ts`) sets `baseTime` / `lastCommittedTime` from the first frame it sees (from whichever track got its SR first) and starts committing.
3. When the other track's SR arrives later, its buffered frames are timed earlier than `lastCommittedTime` and are dropped by `// 過去のフレームを捨てる` (`frame.time < this.lastCommittedTime`).

So the track whose first SR arrives later loses everything before the point the other track has already been committed to.

## Expected

The recording should start as close as possible to the first received media of both tracks, or at least the dropped head should be bounded and documented. Possible directions:

- Hold lip-sync output until every input track has a time base (first SR received), with a timeout for tracks that never send SR.
- Or estimate a provisional NTP mapping before the first SR (e.g. from arrival time) and re-anchor when the SR arrives.

## Reproduction

Run the `av` case of `e2e/tests/mediachannel/recordPlayback.test.ts` against the E2E server (`cd e2e && npm run server` in one shell, then `npx vitest run tests/mediachannel/recordPlayback.test.ts --browser.headless`; the test file lands with the WebM cluster-size ticket branch). Compare the WebM duration (e.g. `ffprobe`) with the recording time; the audio track starts noticeably later than the recording start.

## Notes

- Behavior with `disableNtp: true` (`RtpTimeCallback`) or `disableLipSync: true` has not been measured; worth checking as part of the fix.
- Only verified with Chrome; Firefox / real cameras not tested.