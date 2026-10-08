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
 * Exits 1 if any regression is found.
 */
import { readFileSync } from "node:fs";

type Record = {
  seed: number;
  step: number;
  op?: unknown;
  result?: string;
  states?: string[];
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
  `seeds ${develop.size}, regressions ${regressions}, other divergences ${divergences}`,
);
process.exit(regressions > 0 ? 1 : 0);
