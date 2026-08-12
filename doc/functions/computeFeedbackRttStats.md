[**werift**](../README.md)

***

[werift](../globals.md) / computeFeedbackRttStats

# Function: computeFeedbackRttStats()

> **computeFeedbackRttStats**(`packets`, `feedbackTimeMs`): `undefined` \| \{ `maxFeedbackRttMs`: `number`; `minPropagationRttMs`: `number`; \}

Compute max feedback RTT and min propagation RTT for a received-packet batch
(libwebrtc GoogCcNetworkController::OnTransportPacketsFeedback).

For each received packet with send/recv times:
- feedback_rtt = feedback_time − send_time
- min_pending_time = max_recv_time − receive_time
- propagation_rtt = feedback_rtt − min_pending_time

`feedbackTimeMs` and each packet's `sendMs` must share the **sender local
clock** (production: both from [milliTime](milliTime.md)). Receive times are used
only for pending-time deltas within the batch — pin does not mix wall and
TWCC receive timelines for `feedback_time`.

Returns undefined when there are no finite samples.

## Parameters

### packets

readonly `object`[]

### feedbackTimeMs

`number`

## Returns

`undefined` \| \{ `maxFeedbackRttMs`: `number`; `minPropagationRttMs`: `number`; \}
