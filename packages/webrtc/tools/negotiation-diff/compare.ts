/**
 * Compare two negotiation-diff runs (see run.ts) seed by seed:
 *
 *   npx tsx tools/negotiation-diff/compare.ts <develop.jsonl> <head.jsonl>
 *
 * For every seed it walks the operations in order up to the first step whose
 * outcome differs (after that the two sessions are no longer comparable) and
 * reports a regression when develop resolved the operation and its session
 * communicated afterwards (every negotiated track and the DataChannel, at the
 * next point both peers were stable) while HEAD rejected it or lost
 * communication. Other first differences are counted as divergences.
 *
 * It also checks HEAD on its own, whatever develop did:
 * - hangs: an operation (or one started after close()) that did not settle
 *   within the runner's timeout (`result: "Timeout"`);
 * - failures: connectionState "failed" in a seed with no injected fault
 *   (no mutation, no close), reported in full and where develop did not fail;
 * - state differences: after the same operation with the same outcome, the
 *   transceivers (count, MID, directions, stop) differ from develop's. One
 *   difference is intended and only counted: a transceiver never negotiated
 *   (no currentDirection) whose MID develop assigned at an unapplied
 *   createOffer() while HEAD associates it when a description is applied
 *   (W3C; NEGOTIATION_TRANSACTION.md "Description reuse contract"); such a
 *   transceiver is compared by kind and direction only. MID values may
 *   differ (HEAD keeps MIDs an unapplied offer reserved) but HEAD's must be
 *   unique; a record where develop gave two transceivers one MID (develop's
 *   defect) is counted, not compared. Once a peer is closed, states are not
 *   compared.
 * Exits 1 if any regression, hang, HEAD-only failure or state difference is
 * found.
 */
import { readFileSync } from "node:fs";

type Record = {
  seed: number;
  step: number;
  config?: string;
  op?: unknown;
  result?: string;
  states?: string[];
  fault?: boolean;
  failed?: boolean[];
  transceivers?: unknown;
  comm?: {
    tracks: { [key: string]: boolean };
    dataAtoB: boolean;
    dataBtoA: boolean;
  };
  setupError?: string;
};

const load = (file: string) => {
  const bySeed = new Map<number, Record[]>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Record;
    bySeed.set(record.seed, [...(bySeed.get(record.seed) ?? []), record]);
  }
  return bySeed;
};

const [developFile, headFile] = process.argv.slice(2);
const develop = load(developFile);
const head = load(headFile);

/** Communication channels that work in `base` but not in `next`. */
function lost(base: Record["comm"], next: Record["comm"]) {
  if (!base) return [];
  const missing: string[] = [];
  for (const [key, ok] of Object.entries(base.tracks)) {
    if (ok && !next?.tracks[key]) missing.push(`rtp ${key}`);
  }
  if (base.dataAtoB && !next?.dataAtoB) missing.push("data a->b");
  if (base.dataBtoA && !next?.dataBtoA) missing.push("data b->a");
  return missing;
}

let regressions = 0;
let divergences = 0;
let hangs = 0;
let failuresWithoutFault = 0;
let headOnlyFailures = 0;
let stateDifferences = 0;
let deferredMids = 0;
let developMidCollisions = 0;

type TransceiverState = {
  mid: string | null;
  currentDirection: string | null;
  [key: string]: unknown;
};
/**
 * Whether the transceivers equal develop's, except for the intended
 * difference: a transceiver never negotiated in develop (no
 * currentDirection) that HEAD has not associated with a MID (an unapplied or
 * rolled-back createOffer) is compared by kind and direction only; stopping
 * it is then immediate in HEAD. Counts must match.
 */
function sameTransceivers(dev: unknown, head: unknown) {
  const devPeers = dev as TransceiverState[][];
  const headPeers = head as TransceiverState[][];
  let deferred = false;
  // MID values may differ (HEAD keeps the MIDs an unapplied offer reserved);
  // whether a transceiver has one, and HEAD's MIDs being unique, matter.
  const withoutMid = ({ mid, ...rest }: TransceiverState) => ({
    ...rest,
    hasMid: mid !== null,
  });
  const same = devPeers.every((peer, p) => {
    const other = headPeers[p] ?? [];
    if (peer.length !== other.length) return false;
    if (duplicateMid(other)) return false;
    return peer.every((base, i) => {
      const t = other[i];
      if (
        base.currentDirection === null &&
        t.mid === null &&
        base.mid !== null
      ) {
        deferred = true;
        return base.kind === t.kind && base.direction === t.direction;
      }
      return JSON.stringify(withoutMid(base)) === JSON.stringify(withoutMid(t));
    });
  });
  return { same, deferred };
}

/** Two transceivers of one peer, not stopped, share a MID. */
function duplicateMid(peer: TransceiverState[]) {
  const mids = peer
    .filter((t) => t.mid !== null && !t.stopped)
    .map((t) => t.mid);
  return new Set(mids).size !== mids.length;
}
const report = (kind: string, value: unknown) =>
  console.log(JSON.stringify({ kind, ...(value as object) }));

// HEAD on its own: every operation settles, no failure without a fault.
for (const [seed, records] of head) {
  for (const record of records) {
    if (record.result === "Timeout") {
      hangs++;
      report("hang", {
        seed,
        step: record.step,
        config: record.config,
        op: record.op,
      });
    }
    if (!record.fault && record.failed?.some(Boolean)) {
      failuresWithoutFault++;
      const base = develop.get(seed)?.find((r) => r.step === record.step);
      const sameHistory =
        JSON.stringify(base?.op) === JSON.stringify(record.op);
      if (sameHistory && !base?.failed?.some(Boolean)) {
        headOnlyFailures++;
        report("failed-only-in-head", {
          seed,
          step: record.step,
          config: record.config,
          op: record.op,
          failed: record.failed,
        });
      }
    }
  }
}
for (const [seed, developRecords] of develop) {
  const headRecords = head.get(seed) ?? [];
  for (const [index, base] of developRecords.entries()) {
    const next = headRecords[index];
    if (!next) break;
    if (JSON.stringify(base.op) !== JSON.stringify(next.op)) {
      divergences++;
      break;
    }
    const sameOutcome =
      base.result === next.result &&
      JSON.stringify(base.states) === JSON.stringify(next.states);
    // A closed peer's transceivers are all stopped: after close() only
    // settling is checked (hangs above).
    const compared =
      sameOutcome &&
      base.transceivers !== undefined &&
      !base.states?.includes("closed")
        ? sameTransceivers(base.transceivers, next.transceivers)
        : undefined;
    if (compared?.deferred) deferredMids++;
    // develop handing one MID to two transceivers is its own defect: that
    // record is counted, not compared.
    const developCollision =
      !!compared &&
      (base.transceivers as TransceiverState[][]).some((peer) => {
        const mids = peer.filter((t) => t.mid !== null).map((t) => t.mid);
        return new Set(mids).size !== mids.length;
      });
    if (developCollision) developMidCollisions++;
    if (compared && !compared.same && !developCollision) {
      stateDifferences++;
      report("transceiver-state-difference", {
        seed,
        step: base.step,
        config: base.config,
        op: base.op,
        develop: base.transceivers,
        head: next.transceivers,
        history: developRecords
          .slice(0, index)
          .map((r) => `${JSON.stringify(r.op)} -> ${r.result}`),
      });
      break;
    }
    const missing = lost(base.comm, next.comm);
    // develop accepted the operation and its session communicated at the
    // next point both peers were stable.
    const nextStable = developRecords.slice(index).find((r) => r.comm);
    const developWorked =
      base.result === "ok" &&
      !!nextStable?.comm &&
      Object.values(nextStable.comm.tracks).every(Boolean) &&
      nextStable.comm.dataAtoB &&
      nextStable.comm.dataBtoA;
    if (developWorked && (next.result !== "ok" || missing.length > 0)) {
      regressions++;
      console.log(
        JSON.stringify({
          seed,
          step: base.step,
          op: base.op,
          develop: { result: base.result, states: base.states },
          head: { result: next.result, states: next.states },
          lost: missing,
          history: developRecords
            .slice(0, index)
            .map((r) => `${JSON.stringify(r.op)} -> ${r.result}`),
        }),
      );
      break;
    }
    if (!sameOutcome || missing.length > 0) {
      divergences++;
      break;
    }
  }
}
console.error(
  `seeds ${develop.size}, regressions ${regressions}, other divergences ${divergences}, ` +
    `hangs ${hangs}, failed without fault ${failuresWithoutFault} ` +
    `(HEAD only ${headOnlyFailures}), transceiver state differences ${stateDifferences} ` +
    `(records with an intended deferred MID: ${deferredMids}, develop MID collisions: ${developMidCollisions})`,
);
process.exit(
  regressions + hangs + headOnlyFailures + stateDifferences > 0 ? 1 : 0,
);
