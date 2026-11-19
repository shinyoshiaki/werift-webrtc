## Problem
A downstream report from dTelecom/server-sdk-node describes ICE candidate addition failing against Pion when `sdpMid: ""` is supplied together with a valid `sdpMLineIndex`. The downstream workaround removes the empty MID and resolves by m-line index.

In current `develop`, `packages/webrtc/src/negotiation/remoteCandidates.ts` appears to select MID lookup whenever `typeof sdpMid === "string"`, including the empty string, instead of falling back to the index. It is not yet established whether the empty MID is standards-valid in this scenario, so the desired behavior should be determined before changing validation.

## Investigation / acceptance criteria
- Add a regression fixture with Pion-style `sdpMid: ""` plus valid `sdpMLineIndex`.
- Verify browser/WebRTC-spec behavior for an empty-but-present MID versus null/absent MID.
- Decide whether to normalize empty MID to absent, reject with a clear error, or use the index; document compatibility and standards trade-offs.
- Verify BUNDLE and non-BUNDLE routing and prevent candidates being assigned to the wrong m-line.

## Scope
This is an interoperability investigation, not a claim that every empty MID must be accepted. Distinct from #705 (unsupported RTP m-lines in SDP answers).