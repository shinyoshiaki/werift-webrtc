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
 *     --steps 12 --out /tmp/head.jsonl [--mutate 0.3]
 *
 * With `--mutate p`, a delivered description is rewritten on the wire by one
 * or two peer-diversity mutations (mutations.ts) with probability p.
 *
 * The generator follows the public API along the axes a reviewer explores:
 * - configuration, per seed (`--configs all`, default): bundlePolicy
 *   (max-bundle / balanced / max-compat / disable), rtcpMuxPolicy, and a
 *   relay-only session over a local TURN server;
 * - application operations: stop, replaceTrack, direction,
 *   setCodecPreferences, createDataChannel, restartIce;
 * - timing: `closeDuring` starts an operation and calls close() after 0..8
 *   microtasks or one macrotask (the session ends there);
 * - compositions the random sequence rarely reaches: `pranswerRound` (a new
 *   m-line answered by a pranswer held for a while, then the final answer)
 *   and `remoteOfferAppOpRollback` (the peer's offer, an application
 *   operation on the transceiver it created, rollback on both sides);
 * - the peer: the mutations above.
 * `--ops '<json list>'` (with an optional `--config <name>`) replays a fixed
 * operation list as seed `--first` in the same record format, so a found
 * difference can be checked again on develop and HEAD.
 *
 * Every record carries what compare.ts checks on HEAD: whether the operation
 * settled within the timeout (`result: "Timeout"` otherwise), whether either
 * connectionState reported "failed" (`failed`) and whether a fault was
 * injected before (`fault`: a mutation or close), and both peers'
 * transceivers (count, MID, directions, stop).
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { pathToFileURL } from "node:url";
import {
  type Api,
  type Ctx,
  communication,
  loadApi,
  rng,
  session,
  transceiverSnapshot,
  withTimeout,
} from "./lib";
import { MUTATION_NAMES, mutate } from "./mutations";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const root = resolve(args.get("root") ?? join(__dirname, "../../../.."));
const seeds = Number(args.get("seeds") ?? 50);
const firstSeed = Number(args.get("first") ?? 1);
const steps = Number(args.get("steps") ?? 12);
const out = args.get("out") ?? "/tmp/negotiation-diff.jsonl";
const mutateChance = Number(args.get("mutate") ?? 0);
const configAxis = args.get("configs") ?? "all";
/** An operation that has not settled after this long is recorded as a hang. */
const settleTimeoutMs = Number(args.get("settle-timeout") ?? 10000);

const CONFIGS = [
  "default",
  "balanced",
  "max-compat",
  "disable",
  "rtcpMuxRequire",
  "relay",
] as const;
type ConfigName = (typeof CONFIGS)[number];

/** Configuration of a seed's session (and a TURN server for "relay"). */
async function sessionConfig(name: ConfigName) {
  switch (name) {
    case "default":
      return { config: {} };
    case "balanced":
    case "max-compat":
    case "disable":
      return { config: { bundlePolicy: name } };
    case "rtcpMuxRequire":
      return { config: { rtcpMuxPolicy: "require" } };
    case "relay": {
      const { NodeTurnServer } = await import(
        pathToFileURL(join(root, "packages/ice-server/src/index.ts")).href
      );
      const server = new NodeTurnServer({
        host: "127.0.0.1",
        port: 0,
        relayAddress: "127.0.0.1",
        relayBindAddress: "127.0.0.1",
        credentials: { diff: "diff-password" },
      });
      await server.listen();
      const [host, port] = server.address;
      return {
        config: {
          iceServers: [
            {
              urls: `turn:${host}:${port}?transport=udp`,
              username: "diff",
              credential: "diff-password",
            },
          ],
          iceTransportPolicy: "relay",
        },
        close: () => server.close(),
      };
    }
  }
}

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
    "stop",
    "replaceTrack",
    "direction",
    "setCodecPreferences",
    "createDataChannel",
    "restartIce",
    "closeDuring",
    "pranswerRound",
    "remoteOfferAppOpRollback",
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
    case "stop":
      return { kind, peer, index: r.int(1000) };
    case "replaceTrack":
      return { kind, peer, index: r.int(1000), remove: r.chance(0.3) };
    case "direction":
      return {
        kind,
        peer,
        index: r.int(1000),
        direction: r.pick(["sendrecv", "sendonly", "recvonly", "inactive"]),
      };
    case "setCodecPreferences":
      return {
        kind,
        peer,
        index: r.int(1000),
        codecs: r.pick(["H264", "VP8", "reset"]),
      };
    case "pranswerRound":
      return { kind, peer, add: r.pick(["audio", "video"]) };
    case "remoteOfferAppOpRollback":
      return {
        kind,
        peer,
        add: r.pick(["audio", "video"]),
        appOp: r.pick([
          "none",
          "stop",
          "direction",
          "setCodecPreferences",
          "replaceTrack",
          "addTrack",
        ]),
      };
    case "closeDuring":
      return {
        kind,
        peer,
        during: r.pick([
          "createOffer",
          "createAnswer",
          "applyLatest",
          "deliver",
          "rollbackLocal",
          "rollbackRemote",
          "trickle",
        ]),
        ticks: r.chance(0.2) ? "macrotask" : r.int(9),
      };
    case "deliver":
      return mutateChance > 0 && r.chance(mutateChance)
        ? {
            kind,
            peer,
            mutations: Array.from({ length: 1 + r.int(2) }, () =>
              r.pick(MUTATION_NAMES),
            ),
          }
        : { kind, peer };
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
      await self.pc.setRemoteDescription(
        op.mutations
          ? {
              type: description.type,
              sdp: mutate(description.sdp, op.mutations as any),
            }
          : description,
      );
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
    case "stop":
    case "replaceTrack":
    case "direction":
    case "setCodecPreferences": {
      const transceivers = self.pc
        .getTransceivers()
        .filter((t: any) =>
          op.kind === "setCodecPreferences" ? t.kind === "video" : true,
        );
      const transceiver =
        transceivers[(op.index as number) % transceivers.length];
      if (!transceiver) {
        throw Object.assign(new Error("no transceiver"), { name: "Skip" });
      }
      if (op.kind === "stop") transceiver.stop();
      if (op.kind === "direction") transceiver.direction = op.direction;
      if (op.kind === "replaceTrack") {
        const track = op.remove
          ? null
          : new api.MediaStreamTrack({ kind: transceiver.kind });
        if (track) self.outgoing.set(transceiver, track);
        else self.outgoing.delete(transceiver);
        await transceiver.sender.replaceTrack(track);
      }
      if (op.kind === "setCodecPreferences") {
        transceiver.setCodecPreferences(
          op.codecs === "H264"
            ? [api.useH264()]
            : op.codecs === "VP8"
              ? [api.useVP8()]
              : [],
        );
      }
      return;
    }
    case "createDataChannel":
      self.pc.createDataChannel(`extra-${self.pool.length}`);
      return;
    case "restartIce":
      self.pc.restartIce();
      return;
    case "closeDuring": {
      // The operation and anything started after close() must settle.
      const running = apply(ctx, { kind: op.during as string, peer: op.peer });
      // Settled below; a rejection before that is expected, not unhandled.
      running.catch(() => undefined);
      if (op.ticks === "macrotask") {
        await new Promise((resolve) => setImmediate(resolve));
      } else {
        for (let i = 0; i < (op.ticks as number); i++) await Promise.resolve();
      }
      await self.pc.close();
      const settled = await withTimeout(
        Promise.allSettled([running, self.pc.createOffer()]),
        settleTimeoutMs,
      ).then(
        () => true,
        () => false,
      );
      if (!settled) {
        throw Object.assign(new Error("not settled after close"), {
          name: "Timeout",
        });
      }
      return;
    }
    case "pranswerRound":
    case "remoteOfferAppOpRollback":
      // A composition starts from a negotiated, stable session.
      if (
        self.pc.signalingState !== "stable" ||
        other.pc.signalingState !== "stable"
      ) {
        throw Object.assign(new Error("not stable"), { name: "Skip" });
      }
      return applyComposition(ctx, op);
  }
}

/** The compositions of nextOp (see the header), from stable peers. */
async function applyComposition(ctx: Ctx, op: Op) {
  const self = ctx[op.peer ?? "a"];
  const other = self === ctx.a ? ctx.b : ctx.a;
  const { api } = ctx;
  switch (op.kind) {
    case "pranswerRound": {
      // `self` offers a new m-line; `other` answers with a pranswer first.
      const track = new api.MediaStreamTrack({ kind: op.add });
      self.outgoing.set(
        self.pc.addTransceiver(track, { direction: "sendrecv" }),
        track,
      );
      await self.pc.setLocalDescription(await self.pc.createOffer());
      await other.pc.setRemoteDescription(self.pc.localDescription);
      const answer = await other.pc.createAnswer();
      await other.pc.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await self.pc.setRemoteDescription(other.pc.localDescription);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await other.pc.setLocalDescription({ type: "answer", sdp: answer.sdp });
      await self.pc.setRemoteDescription(other.pc.localDescription);
      return;
    }
    case "remoteOfferAppOpRollback": {
      // `other` offers a new m-line; `self` applies it, uses the transceiver
      // the offer created, then both roll back.
      other.pc.addTransceiver(op.add, { direction: "sendrecv" });
      await other.pc.setLocalDescription(await other.pc.createOffer());
      const before = new Set(self.pc.getTransceivers());
      await self.pc.setRemoteDescription(other.pc.localDescription);
      const created = self.pc
        .getTransceivers()
        .find((t: any) => !before.has(t));
      if (created) {
        // The session attaches a track to every remote-created transceiver;
        // this composition models an application that has not (yet).
        await created.sender.replaceTrack(null);
        self.outgoing.delete(created);
        if (op.appOp === "stop") created.stop();
        if (op.appOp === "direction") created.direction = "sendonly";
        if (op.appOp === "setCodecPreferences" && created.kind === "video") {
          created.setCodecPreferences([api.useVP8()]);
        }
        if (op.appOp === "replaceTrack") {
          await created.sender.replaceTrack(
            new api.MediaStreamTrack({ kind: created.kind }),
          );
        }
        if (op.appOp === "addTrack") {
          self.pc.addTrack(new api.MediaStreamTrack({ kind: created.kind }));
        }
      }
      await self.pc.setRemoteDescription({ type: "rollback" });
      await other.pc.setLocalDescription({ type: "rollback" });
      return;
    }
  }
}

async function main() {
  const scripted = args.get("check-setup")
    ? undefined
    : (JSON.parse(args.get("ops") ?? "null") as Op[] | null);
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
  const lastSeed = scripted ? firstSeed + 1 : firstSeed + seeds;
  for (let seed = firstSeed; seed < lastSeed; seed++) {
    const r = rng(seed);
    // The configuration comes from its own stream: seeds keep their operations.
    const configName: ConfigName = scripted
      ? ((args.get("config") as ConfigName | undefined) ?? "default")
      : configAxis === "all"
        ? rng(seed * 92821 + 5).pick(CONFIGS)
        : "default";
    const configured = await sessionConfig(configName);
    let ctx: Ctx;
    try {
      ctx = await withTimeout(session(api, configured.config), 15000);
    } catch (error) {
      lines.push(
        JSON.stringify({
          seed,
          step: -1,
          config: configName,
          setupError: String(error),
        }),
      );
      await configured.close?.();
      continue;
    }
    let fault = false;
    try {
      const stepCount = scripted ? scripted.length : steps;
      for (let step = 0; step < stepCount; step++) {
        const op = scripted ? scripted[step] : nextOp(ctx, r);
        if (op.mutations || op.kind === "closeDuring") fault = true;
        ctx.a.failed = false;
        ctx.b.failed = false;
        let result = "ok";
        try {
          await withTimeout(apply(ctx, op), settleTimeoutMs);
        } catch (error) {
          result = (error as Error)?.name ?? "Error";
        }
        const states = [ctx.a.pc.signalingState, ctx.b.pc.signalingState];
        const record: Record<string, unknown> = {
          seed,
          step,
          config: configName,
          op,
          result,
          states,
          fault,
          transceivers: [
            transceiverSnapshot(ctx.a),
            transceiverSnapshot(ctx.b),
          ],
        };
        if (states.every((state) => state === "stable")) {
          record.comm = await communication(ctx, `s${seed}-${step}`);
        }
        record.failed = [!!ctx.a.failed, !!ctx.b.failed];
        lines.push(JSON.stringify(record));
        if (states.includes("closed")) break;
      }
    } finally {
      await Promise.allSettled([ctx.a.pc.close(), ctx.b.pc.close()]);
      await configured.close?.();
    }
    // Written after every seed, so an interrupted run keeps its results.
    writeFileSync(out, `${lines.join("\n")}\n`);
    process.stderr.write(`seed ${seed} done\n`);
  }
  writeFileSync(out, `${lines.join("\n")}\n`);
  process.exit(0);
}

void main();
