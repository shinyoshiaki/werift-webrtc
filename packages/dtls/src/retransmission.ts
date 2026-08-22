/**
 * DTLS retransmission timer (RFC 6347 §4.2.4.1 / RFC 9147 §5.8.2).
 *
 * Shared by DTLS 1.2 Flight.transmit and DTLS 1.3 flight-tx.
 *
 * - RTT unknown: INITIAL_RTO_MS (1000). DTLS-SRTP profile may use
 *   DTLS_SRTP_INITIAL_RTO_MS (400) when use_srtp is configured.
 * - RTT known (carrier.updateRtt / ICE): base = RTO_FACTOR × RTT (1.5).
 * - Each retransmit doubles; clamp to [MIN_RTO_MS, MAX_RTO_MS].
 */
export const RTO_FACTOR = 1.5;
/** RFC recommended initial RTO when RTT is unknown. */
export const INITIAL_RTO_MS = 1000;
/** RFC recommended initial RTO for the DTLS-SRTP profile. */
export const DTLS_SRTP_INITIAL_RTO_MS = 400;
export const MIN_RTO_MS = 100;
/**
 * Soft upper bound on a single RTO. RFC does not mandate a max; 60s bounds
 * pathological backoff without a 5s generic-DTLS clamp.
 */
export const MAX_RTO_MS = 60_000;

export function computeDtlsRtoMs(input: {
  rttMs: number;
  retransmitCount: number;
  useSrtpProfile: boolean;
}): number {
  const { rttMs, retransmitCount, useSrtpProfile } = input;
  let base: number;
  if (rttMs > 0) {
    base = Math.round(rttMs * RTO_FACTOR);
  } else {
    base = useSrtpProfile ? DTLS_SRTP_INITIAL_RTO_MS : INITIAL_RTO_MS;
  }
  base = Math.min(MAX_RTO_MS, Math.max(MIN_RTO_MS, base));
  const rto = Math.round(base * 2 ** retransmitCount);
  return Math.min(MAX_RTO_MS, rto);
}
