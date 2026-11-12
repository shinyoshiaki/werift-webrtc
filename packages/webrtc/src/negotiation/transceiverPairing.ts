import type { TransceiverPairing } from "../api/peerConfig";
import type { RTCRtpTransceiver, TransceiverOrigin } from "../media";
import type { MediaDescription } from "../sdp";

/** @internal What remote m-line association sees of a transceiver. */
export type PairingState = {
  mid: string | null;
  mLineIndex?: number;
  stopping: boolean;
  stopped: boolean;
  createdBy: TransceiverOrigin;
};

/**
 * @internal The state a transceiver has when a remote offer's m-lines are
 * associated; `undefined` when it will no longer exist then (a rollback
 * removes it). `planCodecs` runs before the implicit rollback / replacement /
 * revert a remote offer performs and `apply` after it, so both resolve the
 * pairing through the view of the state `apply` will see.
 */
export type PairingView = (
  transceiver: RTCRtpTransceiver,
) => PairingState | undefined;

/** @internal The live state (nothing is restored before the association). */
export const livePairingState = (
  transceiver: RTCRtpTransceiver,
): PairingState => ({
  mid: transceiver.mid,
  mLineIndex: transceiver.mLineIndex,
  stopping: transceiver.stopping,
  stopped: transceiver.stopped,
  createdBy: transceiver.createdBy,
});

/** @internal The view of the live state. */
export const livePairingView: PairingView = livePairingState;

/**
 * @internal The transceiver a remote m-line is associated with (RFC 8829
 * 5.10), or `undefined` when the offer needs a new one (or a rejected m-line
 * with an unknown MID gets none).
 *
 * - A transceiver with the m-line's MID wins, whatever created it.
 * - A port-0 m-line with an unknown MID takes no transceiver.
 * - Otherwise an unassociated (`mid == null`), non-stopping, non-stopped
 *   transceiver of the same kind is taken, the one at the same m-line index
 *   first. Under `"standard"` it must have been created by `addTrack()` (or a
 *   rollback promoted it to that), and the m-line must be sendrecv or
 *   recvonly (a `sendonly` / `inactive` m-line gets a new transceiver, RFC 9429
 *   5.10); under `"legacy"` any origin and direction pairs.
 * - A transceiver in `associated` (already paired with an earlier m-line of
 *   the same description) is never paired twice.
 */
export function matchRemoteTransceiver(
  remoteMedia: MediaDescription,
  index: number,
  transceivers: readonly RTCRtpTransceiver[],
  associated: ReadonlySet<RTCRtpTransceiver>,
  pairing: TransceiverPairing,
  view: PairingView = livePairingView,
): RTCRtpTransceiver | undefined {
  const candidates = transceivers.flatMap((transceiver) => {
    if (associated.has(transceiver) || transceiver.kind !== remoteMedia.kind) {
      return [];
    }
    const state = view(transceiver);
    return state ? [{ transceiver, state }] : [];
  });
  const mid = remoteMedia.rtp.muxId;
  const byMid =
    mid != undefined
      ? candidates.find(({ state }) => state.mid === mid)
      : undefined;
  if (byMid) {
    return byMid.transceiver;
  }
  if (remoteMedia.port === 0) {
    return;
  }
  if (
    pairing === "standard" &&
    (remoteMedia.direction === "sendonly" ||
      remoteMedia.direction === "inactive")
  ) {
    return;
  }
  const unassociated = candidates.filter(
    ({ state }) =>
      state.mid == null &&
      !state.stopping &&
      !state.stopped &&
      (pairing === "legacy" || state.createdBy === "addTrack"),
  );
  return (
    unassociated.find(({ state }) => state.mLineIndex === index) ??
    unassociated[0]
  )?.transceiver;
}
