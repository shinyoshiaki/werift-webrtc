/**
 * Negotiation differential fuzz runner (public API only).
 *
 * Runs seeded operation sequences on two RTCPeerConnections of the werift
 * checkout at `--root` and writes one JSONL record per operation: whether it
 * resolved or rejected (error name), both signaling states, and, whenever
 * both peers are stable, RTP arrival per negotiated track and DataChannel
 * delivery in both directions. Run it on HEAD and on a temporary develop
 * worktree with the same seeds and compare the outputs with `compare.ts`.
 *
 *   npx tsx tools/negotiation-diff/run.ts --root <repo> --seeds 200 \
 *     --steps 12 --out /tmp/head.jsonl
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type Api,
  type Ctx,
  communication,
  loadApi,
  rng,
  session,
  withTimeout,
} from "./lib";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const root = resolve(args.get("root") ?? join(__dirname, "../../../.."));
const seeds = Number(args.get("seeds") ?? 50);
const firstSeed = Number(args.get("first") ?? 1);
const steps = Number(args.get("steps") ?? 12);
const out = args.get("out") ?? "/tmp/negotiation-diff.jsonl";

type Op = { kind: string; peer?: "a" | "b"; [key: string]: unknown };

/** The next operation, from the RNG and the (implementation-equal) state. */
function nextOp(ctx: Ctx, r: ReturnType<typeof rng>): Op {
  const peer = r.pick(["a", "b"] as const);
  const self = ctx[peer];
  const kind = r.pick([
    "createOffer",
    "createOffer",
    "createAnswer",
    "applyLatest",
    "applyLatest",
    "applyLatest",
    "applyPooled",
    "deliver",
    "deliver",
    "deliver",
    "rollbackLocal",
    "rollbackRemote",
    "glare",
    "trickle",
  ] as const);
  switch (kind) {
    case "createOffer":
      return {
        kind,
        peer,
        iceRestart: r.chance(0.3),
        before: r.pick([
          "none",
          "none",
          "addAudio",
          "addVideo",
          "codecPreferences",
          "restartIce",
        ]),
      };
    case "applyLatest":
      return { kind, peer, asPranswer: r.chance(0.3) };
    case "applyPooled":
      return {
        kind,
        peer,
        index: self.pool.length ? r.int(self.pool.length) : -1,
        asPranswer: r.chance(0.3),
      };
    case "trickle":
      return { kind, peer, endOfCandidates: r.chance(0.5) };
    default:
      return { kind, peer };
  }
}

async function apply(ctx: Ctx, op: Op) {
  const self = ctx[op.peer ?? "a"];
  const other = self === ctx.a ? ctx.b : ctx.a;
  const { api } = ctx;
  const save = (description: any) =>
    self.pool.push({ type: description.type, sdp: description.sdp });
  switch (op.kind) {
    case "createOffer": {
      if (op.before === "addAudio" || op.before === "addVideo") {
        const kind = op.before === "addAudio" ? "audio" : "video";
        const track = new api.MediaStreamTrack({ kind });
        self.outgoing.set(
          self.pc.addTransceiver(track, { direction: "sendrecv" }),
          track,
        );
      } else if (op.before === "codecPreferences") {
        const video = self.pc
          .getTransceivers()
          .find((t: any) => t.kind === "video" && !t.stopped);
        video?.setCodecPreferences([api.useH264()]);
      } else if (op.before === "restartIce") {
        self.pc.restartIce();
      }
      save(await self.pc.createOffer({ iceRestart: !!op.iceRestart }));
      return;
    }
    case "createAnswer":
      save(await self.pc.createAnswer());
      return;
    case "applyLatest":
    case "applyPooled": {
      const entry =
        op.kind === "applyLatest"
          ? self.pool[self.pool.length - 1]
          : self.pool[op.index as number];
      if (!entry)
        throw Object.assign(new Error("empty pool"), { name: "Skip" });
      const type =
        entry.type === "answer" && op.asPranswer ? "pranswer" : entry.type;
      await self.pc.setLocalDescription({ type, sdp: entry.sdp });
      return;
    }
    case "deliver": {
      const description = other.pc.localDescription;
      if (!description) {
        throw Object.assign(new Error("nothing to deliver"), { name: "Skip" });
      }
      await self.pc.setRemoteDescription(description);
      return;
    }
    case "rollbackLocal":
      await self.pc.setLocalDescription({ type: "rollback" });
      return;
    case "rollbackRemote":
      await self.pc.setRemoteDescription({ type: "rollback" });
      return;
    case "glare": {
      const offerA = await ctx.a.pc.createOffer();
      const offerB = await ctx.b.pc.createOffer();
      await Promise.allSettled([
        ctx.a.pc.setLocalDescription(offerA),
        ctx.b.pc.setLocalDescription(offerB),
      ]);
      // b (polite) takes a's offer with an implicit rollback.
      await ctx.b.pc.setRemoteDescription(ctx.a.pc.localDescription);
      return;
    }
    case "trickle": {
      const candidates = self.candidates.splice(0);
      for (const candidate of candidates) {
        if (candidate === null && !op.endOfCandidates) continue;
        await other.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      return;
    }
  }
}

async function main() {
  if (args.get("check-setup")) {
    const api: Api = await loadApi(root);
    const ctx = await session(api);
    console.log(JSON.stringify(await communication(ctx, "setup")));
    for (const op of JSON.parse(args.get("ops") ?? "[]")) {
      let result = "ok";
      try {
        await apply(ctx, op);
      } catch (error) {
        result = `${(error as Error).name}: ${(error as Error).message}`;
      }
      console.log(
        JSON.stringify(op),
        result,
        ctx.a.pc.signalingState,
        ctx.b.pc.signalingState,
      );
      console.log(JSON.stringify(await communication(ctx, "after")));
    }
    process.exit(0);
  }
  const api: Api = await loadApi(root);
  const lines: string[] = [];
  for (let seed = firstSeed; seed < firstSeed + seeds; seed++) {
    const r = rng(seed);
    let ctx: Ctx;
    try {
      ctx = await withTimeout(session(api), 10000);
    } catch (error) {
      lines.push(JSON.stringify({ seed, step: -1, setupError: String(error) }));
      continue;
    }
    try {
      for (let step = 0; step < steps; step++) {
        const op = nextOp(ctx, r);
        let result = "ok";
        try {
          await withTimeout(apply(ctx, op), 5000);
        } catch (error) {
          result = (error as Error)?.name ?? "Error";
        }
        const states = [ctx.a.pc.signalingState, ctx.b.pc.signalingState];
        const record: Record<string, unknown> = {
          seed,
          step,
          op,
          result,
          states,
        };
        if (states.every((state) => state === "stable")) {
          record.comm = await communication(ctx, `s${seed}-${step}`);
        }
        lines.push(JSON.stringify(record));
      }
    } finally {
      await Promise.allSettled([ctx.a.pc.close(), ctx.b.pc.close()]);
    }
    process.stderr.write(`seed ${seed} done\n`);
  }
  writeFileSync(out, `${lines.join("\n")}\n`);
  process.exit(0);
}

void main();
