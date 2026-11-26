import { describe, expect, test } from "vitest";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxFor,
  firefoxSimulcastLayers,
  firefoxSimulcastOfferWithFid,
  receiveFirefoxSimulcastOffer,
  retransmissionsOf,
} from "./rtpReceiverTestUtils";

/**
 * The RID an RTX packet of a RID m-line repairs, whatever the order of
 * descriptions and packets:
 *
 * 1. a repaired RID on the packet names it, while the committed FID lists
 *    the RTX SSRC or no RID is bound to it yet (a bound RTX SSRC keeps its
 *    RID, as without FID);
 * 2. else, while the committed FID pairs the RTX SSRC with a media SSRC, the
 *    RID that carries (or carried, before a media SSRC change) that media
 *    SSRC; none yet → nothing is restored;
 * 3. else the RID a repaired RID bound the RTX SSRC to. A commit that adds,
 *    changes or removes the RTX SSRC's FID pair drops that binding.
 *
 * A pending description changes the FID table only with a pair for an RTX
 * SSRC the session knows nothing about; a rollback restores the table. An
 * RTX SSRC a media SSRC change retired is never restored. The packet is
 * restored only into a hole of the RID's current media SSRC.
 */
describe("simulcast (RID) RTX restore across FID changes (ordering matrix)", () => {
  const [high, low] = firefoxSimulcastLayers;
  /** The RTX SSRC under test. */
  const rtxSsrc = high.rtxSsrc;
  /** A media SSRC no RID carries. */
  const unlearned = 123456789;
  /** The media SSRC RID high switches to. */
  const switched = 555555;

  const fidMedia = { none: undefined, H: high.ssrc, L: low.ssrc, N: unlearned };
  type Fid = keyof typeof fidMedia;
  type Rid = "none" | "high" | "low";
  type Transaction = "none" | "commit" | "pending" | "rollback";
  type Case = {
    before: Exclude<Fid, "N">;
    prior: Rid;
    switchHigh: boolean;
    after: Fid;
    transaction: Transaction;
    probeRrid: Exclude<Rid, "low">;
  };

  /** The RID that carries / carried a FID media SSRC. */
  const ridOfFid = (fid: Fid): Rid =>
    fid === "H" ? "high" : fid === "L" ? "low" : "none";

  /** The oracle: the RID the probe RTX restores into (see the rules above). */
  const expectedRid = (c: Case): Rid => {
    // A media SSRC change of high retires an RTX SSRC that repaired the old
    // media without being the RID's FID RTX.
    const retiredInHigh =
      c.switchHigh && c.prior === "high" && c.before === "none";
    const bound: Rid = retiredInHigh ? "none" : c.prior;
    const pendingApplies = c.before === "none" && bound === "none";
    const fid: Fid =
      c.transaction === "commit" ||
      (c.transaction === "pending" && pendingApplies)
        ? c.after
        : c.before;
    const binding =
      c.transaction === "commit" && c.before !== c.after ? "none" : bound;
    const rid: Rid =
      c.probeRrid !== "none" && (fid !== "none" || binding === "none")
        ? c.probeRrid
        : fid !== "none"
          ? ridOfFid(fid)
          : binding;
    return rid === "high" && retiredInHigh ? "none" : rid;
  };

  const cases: Case[] = [];
  for (const before of ["none", "H", "L"] as const)
    for (const prior of ["none", "high", "low"] as const)
      for (const switchHigh of [false, true])
        for (const after of ["none", "H", "L", "N"] as const)
          for (const transaction of [
            "none",
            "commit",
            "pending",
            "rollback",
          ] as const)
            for (const probeRrid of ["none", "high"] as const)
              cases.push({
                before,
                prior,
                switchHigh,
                after,
                transaction,
                probeRrid,
              });

  const offer = (fid: Fid) => {
    const media = fidMedia[fid];
    return firefoxSimulcastOfferWithFid(
      media === undefined ? [] : [[media, rtxSsrc]],
    );
  };
  const media = (ssrc: number, sequenceNumber: number, rid: string) =>
    createSimulcastMediaPacket({ ssrc, sequenceNumber, rid, mid: "0" });
  const repair = (
    mediaSsrc: number,
    sequenceNumber: number,
    rtxSequenceNumber: number,
    rrid?: string,
  ) =>
    createSimulcastRtxFor(mediaSsrc, sequenceNumber, {
      rtxSsrc,
      rtxSequenceNumber,
      rrid,
      mid: "0",
    });

  test.each(cases)(
    "FID $before → $after ($transaction), repaired RID before: $prior, high switched: $switchHigh, probe repaired RID: $probeRrid",
    async (c) => {
      // Arrange: FID $before の offer を確定し、両レイヤーに欠落を作り、必要なら repaired RID で RTX SSRC を学習させ、high の媒体 SSRC を切り替える。
      const { pc, route, deliveredOf, remoteOffer } =
        await receiveFirefoxSimulcastOffer(offer(c.before));
      const delivered = { high: deliveredOf("high"), low: deliveredOf("low") };
      try {
        for (const layer of firefoxSimulcastLayers) {
          for (const sequenceNumber of [1, 3, 5]) {
            route(media(layer.ssrc, sequenceNumber, layer.rid));
          }
        }
        if (c.prior !== "none") {
          const layer = c.prior === "high" ? high : low;
          route(repair(layer.ssrc, 2, 1, c.prior));
        }
        if (c.switchHigh) {
          route(media(switched, 10, "high"));
          route(media(switched, 12, "high"));
        }
        const holes = {
          high: c.switchHigh
            ? ([switched, 11] as const)
            : ([high.ssrc, 4] as const),
          low: [low.ssrc, 4] as const,
        };
        const priorRepairs = {
          high: c.prior === "high" ? [[high.ssrc, 2]] : [],
          low: c.prior === "low" ? [[low.ssrc, 2]] : [],
        };

        // Act: FID $after の再 offer を $transaction で適用し (none は再 offer なし)、同じ RTX SSRC から両レイヤーの欠落の再送を受信する。
        if (c.transaction !== "none") {
          await remoteOffer(offer(c.after), {
            answer: c.transaction === "commit",
          });
        }
        if (c.transaction === "rollback") {
          await pc.setRemoteDescription({ type: "rollback", sdp: "" });
        }
        const probeRrid = c.probeRrid === "none" ? undefined : c.probeRrid;
        route(repair(holes.high[0], holes.high[1], 10, probeRrid));
        route(repair(holes.low[0], holes.low[1], 11, probeRrid));

        // Assert: 規則が決めるレイヤーの欠落だけが、そのレイヤーのトラックへ復元される。
        const rid = expectedRid(c);
        expect({
          high: retransmissionsOf(delivered.high),
          low: retransmissionsOf(delivered.low),
        }).toEqual({
          high: [
            ...priorRepairs.high,
            ...(rid === "high" ? [[...holes.high]] : []),
          ],
          low: [
            ...priorRepairs.low,
            ...(rid === "low" ? [[...holes.low]] : []),
          ],
        });
      } finally {
        await pc.close();
      }
    },
  );
});
