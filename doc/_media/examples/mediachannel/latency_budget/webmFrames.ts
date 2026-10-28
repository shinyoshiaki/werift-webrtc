// Reads the frames back out of a .webm written by werift's MediaRecorder, in
// file order, to check what was really saved. Minimal EBML: Segment and
// Cluster (written with unknown size) are entered, every other element is
// skipped by its size, and a SimpleBlock gives its track and frame payload.

const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;

/** EBML variable size integer. `keepMarker` for element IDs. */
function vint(data: Buffer, at: number, keepMarker: boolean) {
  const first = data[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (at + length > data.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[at + i];
    if (data[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

export type WebmFrame = { track: number; payload: Buffer };

export function readWebmFrames(data: Buffer): WebmFrame[] {
  const frames: WebmFrame[] = [];
  let at = 0;
  while (at < data.length) {
    const id = vint(data, at, true);
    if (!id) break;
    const size = vint(data, at + id.length, false);
    if (!size) break;
    const body = at + id.length + size.length;
    if (id.value === SEGMENT || id.value === CLUSTER) {
      at = body;
      continue;
    }
    if (size.unknown || body + size.value > data.length) break;
    if (id.value === SIMPLE_BLOCK) {
      const track = vint(data, body, false);
      if (!track) break;
      // track, int16 relative timecode, flags; no lacing for one Opus frame
      const payloadAt = body + track.length + 3;
      frames.push({
        track: track.value,
        payload: data.subarray(payloadAt, body + size.value),
      });
    }
    at = body + size.value;
  }
  return frames;
}

/**
 * How many of `expected` (in sequence order) the file holds at the same
 * position, byte for byte. Equal to `expected.length` and to the number of
 * frames in the file only when every frame was saved once, in order.
 */
export function countSavedInOrder(frames: WebmFrame[], expected: Buffer[]) {
  let count = 0;
  while (
    count < expected.length &&
    count < frames.length &&
    frames[count].payload.equals(expected[count])
  ) {
    count++;
  }
  return count;
}
