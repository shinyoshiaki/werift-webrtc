import type { MediaStreamTrack } from "../media/track";

export function bindTrackStop(track: MediaStreamTrack, stop: () => void) {
  track.bindUpstreamStop(stop);
}

/** Fires when this track instance stops, even if a shared source still has live clones. */
export function bindOwnTrackStop(track: MediaStreamTrack, stop: () => void) {
  const once = () => {
    track.removeEventListener("ended", once);
    stop();
  };
  track.addEventListener("ended", once);
}
