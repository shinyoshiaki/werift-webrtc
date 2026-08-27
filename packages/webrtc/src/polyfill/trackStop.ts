import type { MediaStreamTrack } from "../media/track";

export function bindTrackStop(track: MediaStreamTrack, stop: () => void) {
  track.bindUpstreamStop(stop);
}
