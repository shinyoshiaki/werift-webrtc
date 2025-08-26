import type {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "../../src/index.js";

// https://w3c.github.io/webrtc-pc/#perfect-negotiation-example

export type SignalingMessagePayload =
  | {
      type: "description";
      description: RTCSessionDescription;
    }
  | {
      type: "candidate";
      candidate: RTCIceCandidate;
    };

/**
 * Abstraction of signaling channel
 */
interface SignalingChannel {
  send: (data: SignalingMessagePayload) => void;
  onMessage: (callback: (data: SignalingMessagePayload) => void) => void;
}

/**
 * Configuration object for Perfect Negotiation setup
 */
interface PerfectNegotiationOptions {
  /** Peer connection */
  pc: RTCPeerConnection;
  /** Whether this peer is polite */
  polite: boolean;
  /** Signaling channel */
  signaling: SignalingChannel;
}

/**
 * Setup function implementing WebRTC Perfect Negotiation pattern
 * @param options Configuration object for Perfect Negotiation setup
 * @returns void
 */
export function setupPerfectNegotiation(
  options: PerfectNegotiationOptions,
): void {
  const { pc, polite, signaling } = options;

  // State management variables
  let makingOffer = false;
  let ignoreOffer = false;
  let srdAnswerPending = false;

  const handleSignalingMessage = async (message: SignalingMessagePayload) => {
    try {
      if (message.type === "description") {
        const { description } = message;
        // Detection and handling of Glare
        const isStable =
          pc.signalingState === "stable" ||
          (pc.signalingState === "have-local-offer" && srdAnswerPending);

        ignoreOffer =
          description.type === "offer" && !polite && (makingOffer || !isStable);

        if (ignoreOffer) {
          return;
        }

        srdAnswerPending = description.type === "answer";

        // Set remote description
        await pc.setRemoteDescription(description);

        srdAnswerPending = false;

        // Generate and send answer to offer
        if (description.type === "offer") {
          await pc.setLocalDescription();

          if (pc.localDescription) {
            send({ type: "description", description: pc.localDescription });
          } else {
            console.error("Local description is null");
          }
        } else if (description.type === "answer") {
          // end
        }
      } else if (message.type === "candidate") {
        try {
          await pc.addIceCandidate(message.candidate);
        } catch (e) {
          // Ignore errors for ICE candidates during ignoreOffer
          if (!ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.error("Error in signaling message handling", e);
    }
  };

  const send = (data: SignalingMessagePayload) => {
    signaling.send(data);
  };

  // ICE candidate processing
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) {
      return;
    }
    send({ type: "candidate", candidate });
  };

  // Handling when negotiation is needed
  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;

      // Set local description
      await pc.setLocalDescription();

      // Send offer
      if (pc.localDescription) {
        send({ type: "description", description: pc.localDescription });
      } else {
        console.error("Local description is null");
      }
    } catch (e) {
      console.error("Negotiation needed failed", e);
    } finally {
      makingOffer = false;
    }
  };

  // Processing signaling messages
  signaling.onMessage(handleSignalingMessage);
}
