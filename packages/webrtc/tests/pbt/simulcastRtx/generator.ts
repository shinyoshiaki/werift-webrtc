import type { SeededRandom } from "../shared/random";

/**
 * Generators of the simulcast RTX property test
 * (`simulcastRtxProperty.test.ts`). Every value is drawn from the seed's
 * stream.
 */

/** One media stream of a RID: its SSRC, its RTX SSRC and its random bases. */
export interface SimulcastStream {
  rid: string;
  ssrc: number;
  rtxSsrc: number;
  /** Original packets by 16-bit sequence number. */
  packets: Map<number, { timestamp: number; payload: string }>;
}

/** One packet on the wire, in arrival order. */
export type SimulcastArrival =
  | { kind: "media"; stream: SimulcastStream; seq: number; withRid: boolean }
  | {
      kind: "rtx";
      stream: SimulcastStream;
      seq: number;
      rtxSeq: number;
      withRrid: boolean;
    };

const RIDS = ["high", "low"] as const;

function uint32(rng: SeededRandom) {
  return Math.floor(rng.next() * 0x100000000) >>> 0;
}

/**
 * Two RIDs whose media SSRC changes 0-5 times without renegotiation (beyond
 * the receiver's per-RID bound of 4, so old SSRCs are evicted; the old
 * stream's late packets overlap the new one), RTP bases random per SSRC as
 * RFC 3550 requires (sequence bases sometimes shared, so the streams of a RID
 * lose the same numbers). Packets are lost, delayed or reordered; a lost
 * packet is repaired by RTX after a delay (sometimes twice, sometimes also
 * arriving late itself), and RTX that answers no NACK is injected: duplicates
 * of received packets, packets not sent yet, RTX ahead of any media of its
 * SSRC. `rtp-stream-id` / `repaired-rtp-stream-id` are sent on the first
 * packets of an SSRC only, as libwebrtc stops after an RTCP RR.
 */
export function randomSimulcastRtxTraffic(
  rng: SeededRandom,
  length: number,
): { streams: SimulcastStream[]; arrivals: SimulcastArrival[] } {
  const streams: SimulcastStream[] = [];
  const timed: { time: number; arrival: SimulcastArrival }[] = [];
  const usedSsrcs = new Set<number>();
  const newSsrc = () => {
    let ssrc = uint32(rng);
    while (ssrc === 0 || usedSsrcs.has(ssrc)) ssrc = uint32(rng);
    usedSsrcs.add(ssrc);
    return ssrc;
  };

  for (const rid of RIDS) {
    const count = rng.int(1, 7);
    const sharedSeqBase = rng.chance(0.5) ? rng.int(0, 0x10000) : undefined;
    for (let k = 0; k < count; k++) {
      const stream: SimulcastStream = {
        rid,
        ssrc: newSsrc(),
        rtxSsrc: newSsrc(),
        packets: new Map(),
      };
      streams.push(stream);
      const seqBase = sharedSeqBase ?? rng.int(0, 0x10000);
      const tsBase = uint32(rng);
      // 新しい SSRC は前の SSRC の終盤から始まり、旧パケットの遅着と重なる。
      const start = k * length * rng.between(0.5, 0.9);
      const ridPackets = rng.int(1, 20);
      const rridPackets = rng.int(1, 4);
      let frame = 0;
      let rtxSeq = rng.int(0, 0x10000);
      let rtxSent = 0;
      const rtx = (seq: number, time: number) => {
        timed.push({
          time,
          arrival: {
            kind: "rtx",
            stream,
            seq,
            rtxSeq: rtxSeq++ & 0xffff,
            withRrid: rtxSent++ < rridPackets || rng.chance(0.1),
          },
        });
      };

      for (let i = 0; i < length; i++) {
        if (i > 0 && rng.chance(0.4)) frame++;
        const seq = (seqBase + i) & 0xffff;
        const timestamp = (tsBase + frame * 3000) >>> 0;
        stream.packets.set(seq, {
          timestamp,
          payload: `${stream.ssrc}:${seq}`,
        });
        const time = start + i + rng.between(0, 3);
        const media = (at: number) =>
          timed.push({
            time: at,
            arrival: { kind: "media", stream, seq, withRid: i < ridPackets },
          });

        if (rng.chance(0.12)) {
          // 欠落: NACK の往復後に RTX が届く。重複や原本の遅着もある。
          const repairAt = time + rng.between(3, 40);
          if (!rng.chance(0.1)) rtx(seq, repairAt);
          if (rng.chance(0.15)) rtx(seq, repairAt + rng.between(1, 30));
          if (rng.chance(0.2)) media(time + rng.between(2, 60));
        } else {
          media(time);
        }
        // NACK に応えていない RTX: 受信済みの重複、まだ送っていない番号、媒体より前。
        if (rng.chance(0.03)) rtx(seq, time + rng.between(-20, 20));
      }
    }
  }

  timed.sort((a, b) => a.time - b.time);
  return { streams, arrivals: timed.map(({ arrival }) => arrival) };
}
