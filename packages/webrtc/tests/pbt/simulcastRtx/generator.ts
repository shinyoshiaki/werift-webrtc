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
  /** Position in the stream (extended sequence number - base) by 16-bit number. */
  indexBySeq: Map<number, number>;
}

/** One packet on the wire, in arrival order. */
export type SimulcastArrival =
  | {
      kind: "media";
      stream: SimulcastStream;
      seq: number;
      index: number;
      withRid: boolean;
    }
  | {
      kind: "rtx";
      stream: SimulcastStream;
      seq: number;
      index: number;
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
 * packets of an SSRC only, as libwebrtc stops after an RTCP RR. Some streams
 * send frames out of display order (B-frames: timestamps not monotonic in
 * sending order), and some lose long bursts (100-900 packets) of which only
 * the newest 150, the numbers `NackHandler` keeps asking for, are repaired.
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
    let nextStart = 0;
    for (let k = 0; k < count; k++) {
      const stream: SimulcastStream = {
        rid,
        ssrc: newSsrc(),
        rtxSsrc: newSsrc(),
        packets: new Map(),
        indexBySeq: new Map(),
      };
      streams.push(stream);
      const seqBase = sharedSeqBase ?? rng.int(0, 0x10000);
      const tsBase = uint32(rng);
      const start = nextStart;
      const ridPackets = rng.int(1, 20);
      const rridPackets = rng.int(1, 4);
      let frame = 0;
      // B フレーム: 復号順 [P, B, B] の表示時刻は [f+2, f, f+1]。
      const bFrames = rng.chance(0.4);
      const displayFrame = (f: number) =>
        !bFrames ? f : f % 3 === 0 ? f + 2 : f - 1;
      // 長い連続欠落: 開始位置と長さ。その分ストリームを延ばし、欠落後も受信が続く。
      const bursts: { from: number; to: number }[] = [];
      let streamLength = length;
      for (let b = rng.chance(0.4) ? rng.int(1, 3) : 0; b > 0; b--) {
        const burst = rng.int(100, 900);
        const from = rng.int(10, streamLength);
        bursts.push({ from, to: from + burst });
        streamLength += burst;
      }
      // 次の SSRC はこの SSRC の終盤から始まり、旧パケットの遅着と重なる。
      nextStart = start + streamLength * rng.between(0.5, 0.9);
      let rtxSeq = rng.int(0, 0x10000);
      let rtxSent = 0;
      const rtx = (index: number, seq: number, time: number) => {
        timed.push({
          time,
          arrival: {
            kind: "rtx",
            stream,
            seq,
            index,
            rtxSeq: rtxSeq++ & 0xffff,
            withRrid: rtxSent++ < rridPackets || rng.chance(0.1),
          },
        });
      };

      for (let i = 0; i < streamLength; i++) {
        if (i > 0 && rng.chance(0.4)) frame++;
        const seq = (seqBase + i) & 0xffff;
        const timestamp = (tsBase + displayFrame(frame) * 3000) >>> 0;
        stream.packets.set(seq, {
          timestamp,
          payload: `${stream.ssrc}:${seq}`,
        });
        stream.indexBySeq.set(seq, i);
        const time = start + i + rng.between(0, 3);
        const media = (at: number) =>
          timed.push({
            time: at,
            arrival: {
              kind: "media",
              stream,
              seq,
              index: i,
              withRid: i < ridPackets,
            },
          });

        const burst = bursts.find(({ from, to }) => i >= from && i < to);
        if (burst) {
          // NACK は欠落の新しい 150 個だけを要求し、欠落後の受信から RTT 後に RTX が届く。
          if (i >= burst.to - 150 && !rng.chance(0.1)) {
            rtx(i, seq, start + burst.to + rng.between(3, 40));
          }
          continue;
        }
        if (rng.chance(0.12)) {
          // 欠落: NACK の往復後に RTX が届く。重複や原本の遅着もある。
          const repairAt = time + rng.between(3, 40);
          if (!rng.chance(0.1)) rtx(i, seq, repairAt);
          if (rng.chance(0.15)) rtx(i, seq, repairAt + rng.between(1, 30));
          if (rng.chance(0.2)) media(time + rng.between(2, 60));
        } else {
          media(time);
        }
        // NACK に応えていない RTX: 受信済みの重複、まだ送っていない番号、媒体より前。
        if (rng.chance(0.03)) rtx(i, seq, time + rng.between(-20, 20));
      }
    }
  }

  timed.sort((a, b) => a.time - b.time);
  return { streams, arrivals: timed.map(({ arrival }) => arrival) };
}
