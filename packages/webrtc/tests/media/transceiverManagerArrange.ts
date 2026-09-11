import {
  type PeerConfig,
  TransceiverManager,
  defaultPeerConfig,
} from "../../src";
import { RtpRouter } from "../../src/media/router";

export function createTransceiverManager() {
  return new TransceiverManager(
    "test-cname",
    defaultPeerConfig as Required<PeerConfig>,
    new RtpRouter(),
  );
}
