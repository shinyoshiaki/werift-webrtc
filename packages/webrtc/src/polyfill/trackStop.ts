import type { MediaStreamTrack } from "../media/track";

export function bindTrackStop(track: MediaStreamTrack, stop: () => void) {
  const originalStop = track.stop;
  let stopped = false;
  const dispose = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    stop();
  };
  track.stop = () => {
    dispose();
    originalStop.call(track);
  };
  return dispose;
}
