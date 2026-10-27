/**
 * The description reuse contract: a created description may be applied later
 * or again (after other descriptions were created, after a rollback, after
 * the session became stable, or as a replacement). Each order of operations
 * is a scenario below and `contract` gives its required result:
 *
 * (a) an application W3C requires to accept is accepted;
 * (b) one develop accepted and then communicated with is not regressed (it
 *     is accepted and communicates);
 * (c) anything else is refused with `InvalidModificationError` (or the
 *     exception the specification names) and changes nothing.
 *
 * An order no scenario lists is outside the contract (a follow-up, not a
 * change of it). The scenarios run through the public API and print, per
 * scenario, whether the application under test resolved (or the error name),
 * whether the session then communicates (RTP of every negotiated track and
 * the DataChannel, both ways) and whether the result matches the contract.
 * Run it on HEAD (`--check` exits 1 on a mismatch) and on a develop worktree
 * to measure develop's column of the basis:
 *
 *   node --experimental-transform-types --import ../../tools/node-ts/register.mjs tools/negotiation-diff/scenarios.ts --root <repo> [--check 1]
 *
 * In CI the description-pool episodes of the episode fuzzer
 * (`tests/pbt/fuzz`) check the same contract with an atomicity oracle (a
 * refused operation leaves both peers' snapshot identical).
 */
import { join, resolve } from "node:path";
import {
  type Ctx,
  communication,
  loadApi,
  session,
  sleep,
  withTimeout,
} from "./lib";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const root = resolve(args.get("root") ?? join(import.meta.dirname, "../../../.."));

type Pc = Ctx["a"]["pc"];

async function negotiate(offerer: Pc, answerer: Pc) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
}

/** Answer `answerer`'s pending remote offer with `answer`, both sides. */
async function finish(offerer: Pc, answerer: Pc, answer: any) {
  await answerer.setLocalDescription(answer);
  await offerer.setRemoteDescription(answerer.localDescription);
}

function addAudio(ctx: Ctx, peer: Ctx["a"]) {
  const track = new ctx.api.MediaStreamTrack({ kind: "audio" });
  peer.outgoing.set(
    peer.pc.addTransceiver(track, { direction: "sendrecv" }),
    track,
  );
}

/**
 * Each scenario prepares a connected session, then runs the application under
 * test in `act` (its outcome is the row's result) and completes the
 * negotiation in `after` when `act` resolved.
 */
const scenarios: {
  [name: string]: (ctx: Ctx) =>
    | {
        act: () => Promise<unknown>;
        after?: () => Promise<unknown>;
      }
    | Promise<{ act: () => Promise<unknown>; after?: () => Promise<unknown> }>;
} = {
  async "saved answer, then createOffer, then apply the answer"({ a, b }) {
    await a.pc.setLocalDescription(
      await a.pc.createOffer({ iceRestart: true }),
    );
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const saved = await b.pc.createAnswer();
    await b.pc.createOffer();
    return {
      act: () => b.pc.setLocalDescription(saved),
      after: () => a.pc.setRemoteDescription(b.pc.localDescription),
    };
  },
  async "answer created again, apply the first one"({ a, b }) {
    await a.pc.setLocalDescription(
      await a.pc.createOffer({ iceRestart: true }),
    );
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const saved = await b.pc.createAnswer();
    await b.pc.createAnswer();
    return {
      act: () => b.pc.setLocalDescription(saved),
      after: () => a.pc.setRemoteDescription(b.pc.localDescription),
    };
  },
  async "unapplied restart offer, answer created again, apply the saved one"({
    a,
    b,
  }) {
    await a.pc.setLocalDescription(
      await a.pc.createOffer({ iceRestart: true }),
    );
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const saved = await b.pc.createAnswer();
    await b.pc.createOffer({ iceRestart: true });
    await b.pc.createAnswer();
    return {
      act: () => b.pc.setLocalDescription(saved),
      after: () => a.pc.setRemoteDescription(b.pc.localDescription),
    };
  },
  async "unapplied restart offer, then apply the saved answer"({ a, b }) {
    await a.pc.setLocalDescription(
      await a.pc.createOffer({ iceRestart: true }),
    );
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const saved = await b.pc.createAnswer();
    await b.pc.createOffer({ iceRestart: true });
    return {
      act: () => b.pc.setLocalDescription(saved),
      after: () => a.pc.setRemoteDescription(b.pc.localDescription),
    };
  },
  async "restartIce() + unapplied offer, then apply the saved answer"({
    a,
    b,
  }) {
    await a.pc.setLocalDescription(
      await a.pc.createOffer({ iceRestart: true }),
    );
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const saved = await b.pc.createAnswer();
    b.pc.restartIce();
    await b.pc.createOffer();
    return {
      act: () => b.pc.setLocalDescription(saved),
      after: () => a.pc.setRemoteDescription(b.pc.localDescription),
    };
  },
  async "offer created while a remote offer is pending, applied after stable"(
    ctx,
  ) {
    const { a, b } = ctx;
    addAudio(ctx, b);
    await a.pc.setLocalDescription(await a.pc.createOffer());
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const answer = await b.pc.createAnswer();
    const offer = await b.pc.createOffer();
    await finish(a.pc, b.pc, answer);
    return {
      act: () => b.pc.setLocalDescription(offer),
      after: async () => {
        await a.pc.setRemoteDescription(b.pc.localDescription);
        await finish(b.pc, a.pc, await a.pc.createAnswer());
      },
    };
  },
  async "same offer re-applied after its rollback (new audio)"(ctx) {
    const { a, b } = ctx;
    addAudio(ctx, a);
    const offer = await a.pc.createOffer();
    await a.pc.setLocalDescription(offer);
    await a.pc.setLocalDescription({ type: "rollback" });
    return {
      act: () => a.pc.setLocalDescription(offer),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "same restart offer re-applied after its rollback"({ a, b }) {
    const offer = await a.pc.createOffer({ iceRestart: true });
    await a.pc.setLocalDescription(offer);
    await a.pc.setLocalDescription({ type: "rollback" });
    return {
      act: () => a.pc.setLocalDescription(offer),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "same restart offer (new audio) re-applied after its rollback"(ctx) {
    const { a, b } = ctx;
    addAudio(ctx, a);
    const offer = await a.pc.createOffer({ iceRestart: true });
    await a.pc.setLocalDescription(offer);
    await a.pc.setLocalDescription({ type: "rollback" });
    return {
      act: () => a.pc.setLocalDescription(offer),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "restart offer re-applied after the peer committed another restart"({
    a,
    b,
  }) {
    const offer = await a.pc.createOffer({ iceRestart: true });
    await a.pc.setLocalDescription(offer);
    await a.pc.setLocalDescription({ type: "rollback" });
    b.pc.restartIce();
    await negotiate(b.pc, a.pc);
    await sleep(500);
    return {
      act: () => a.pc.setLocalDescription(offer),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "have-remote-pranswer: replace with the same restart offer"({ a, b }) {
    const offer = await a.pc.createOffer({ iceRestart: true });
    await a.pc.setLocalDescription(offer);
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const pranswer = (await b.pc.createAnswer()).sdp;
    await b.pc.setLocalDescription({ type: "pranswer", sdp: pranswer });
    await a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer });
    return {
      act: () => a.pc.setLocalDescription(offer),
      after: async () => {
        await b.pc.setRemoteDescription({ type: "rollback" });
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "have-remote-pranswer: replace with a new restart offer"({ a, b }) {
    await a.pc.setLocalDescription(
      await a.pc.createOffer({ iceRestart: true }),
    );
    await b.pc.setRemoteDescription(a.pc.localDescription);
    const pranswer = (await b.pc.createAnswer()).sdp;
    await b.pc.setLocalDescription({ type: "pranswer", sdp: pranswer });
    await a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer });
    const replacement = await a.pc.createOffer({ iceRestart: true });
    return {
      act: () => a.pc.setLocalDescription(replacement),
      after: async () => {
        await b.pc.setRemoteDescription({ type: "rollback" });
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "stale offer (an unapplied newer offer exists)"({ a, b }) {
    const stale = await a.pc.createOffer();
    await a.pc.createOffer({ iceRestart: true });
    return {
      act: () => a.pc.setLocalDescription(stale),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "offer re-applied after its answer made the session stable"({ a, b }) {
    const offer = await a.pc.createOffer();
    await a.pc.setLocalDescription(offer);
    await b.pc.setRemoteDescription(a.pc.localDescription);
    await finish(a.pc, b.pc, await b.pc.createAnswer());
    return {
      act: () => a.pc.setLocalDescription(offer),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "munged local offer"({ a, b }) {
    const offer = await a.pc.createOffer();
    const munged = offer.sdp.replace(/a=ice-ufrag:(\S+)/g, "a=ice-ufrag:munge");
    return {
      act: () => a.pc.setLocalDescription({ type: "offer", sdp: munged }),
      after: async () => {
        await b.pc.setRemoteDescription(a.pc.localDescription);
        await finish(a.pc, b.pc, await b.pc.createAnswer());
      },
    };
  },
  async "the peer's previous answer (fewer m-lines) applied to a new offer"(
    ctx,
  ) {
    const { a, b } = ctx;
    const previous = b.pc.localDescription;
    addAudio(ctx, a);
    await a.pc.setLocalDescription(await a.pc.createOffer());
    return {
      act: () =>
        a.pc.setRemoteDescription({ type: "answer", sdp: previous.sdp }),
      after: () => negotiate(a.pc, b.pc),
    };
  },
  async "glare: the polite peer takes the remote offer"({ a, b }) {
    await a.pc.setLocalDescription(await a.pc.createOffer());
    await b.pc.setLocalDescription(await b.pc.createOffer());
    return {
      act: () => b.pc.setRemoteDescription(a.pc.localDescription),
      after: async () => {
        await b.pc.setLocalDescription(await b.pc.createAnswer());
        await a.pc.setRemoteDescription(b.pc.localDescription);
      },
    };
  },
};

/** Every track and the DataChannel (if measured) reached the other peer. */
function communicates(comm: unknown) {
  if (typeof comm !== "object" || !comm) return false;
  const { tracks, dataAtoB, dataBtoA } = comm as {
    tracks: Record<string, boolean>;
    dataAtoB?: boolean;
    dataBtoA?: boolean;
  };
  return (
    Object.values(tracks).every(Boolean) &&
    dataAtoB !== false &&
    dataBtoA !== false
  );
}

const FIRST_PRANSWER_REPLACED =
  "first pranswer connected, then the offer is replaced";

/**
 * Required result of every scenario (`ok` or the error name) and its basis.
 * "develop" is measured with this tool on develop 71b6ddbf.
 */
const contract: { [name: string]: { result: string; basis: string } } = {
  "saved answer, then createOffer, then apply the answer": {
    result: "ok",
    basis:
      "(a) the answer is still [[LastCreatedAnswer]]; develop: accepted, communicates",
  },
  "answer created again, apply the first one": {
    result: "ok",
    basis:
      "(b) develop: accepted, communicates (werift, like develop, does not compare an answer with [[LastCreatedAnswer]])",
  },
  "unapplied restart offer, answer created again, apply the saved one": {
    result: "ok",
    basis: "(b) as above, with an unapplied restart offer in between",
  },
  "unapplied restart offer, then apply the saved answer": {
    result: "ok",
    basis:
      "(a) [[LastCreatedAnswer]] unchanged; develop accepted but lost the session (it restarted ICE at createOffer)",
  },
  "restartIce() + unapplied offer, then apply the saved answer": {
    result: "ok",
    basis: "(a) as above",
  },
  "offer created while a remote offer is pending, applied after stable": {
    result: "ok",
    basis: "(a) it is [[LastCreatedOffer]]; develop: accepted, communicates",
  },
  "same offer re-applied after its rollback (new audio)": {
    result: "ok",
    basis:
      "(a) rollback does not change [[LastCreatedOffer]]; develop: accepted, communicates",
  },
  "same restart offer re-applied after its rollback": {
    result: "ok",
    basis: "(a) as above",
  },
  "same restart offer (new audio) re-applied after its rollback": {
    result: "ok",
    basis: "(a) as above",
  },
  "restart offer re-applied after the peer committed another restart": {
    result: "ok",
    basis:
      "(a) and (b): restarts to the offer's credentials; develop accepted and communicates (it made the credentials live at createOffer)",
  },
  "have-remote-pranswer: replace with the same restart offer": {
    result: "ok",
    basis:
      "werift extension: the remote pranswer is rolled back first (JSEP 5.5 / W3C reject a local offer in this state with InvalidStateError, and develop does)",
  },
  "have-remote-pranswer: replace with a new restart offer": {
    result: "ok",
    basis: "werift extension, as above",
  },
  "stale offer (an unapplied newer offer exists)": {
    result: "InvalidModificationError",
    basis: "W3C: sdp is not [[LastCreatedOffer]]; develop rejects too",
  },
  "offer re-applied after its answer made the session stable": {
    result: "ok",
    basis: "(a) and (b): develop accepted, communicates",
  },
  "munged local offer": {
    result: "InvalidModificationError",
    basis: "W3C: sdp is not [[LastCreatedOffer]]; develop rejects too",
  },
  "the peer's previous answer (fewer m-lines) applied to a new offer": {
    result: "ok",
    basis:
      "(b) develop: accepted, communicates; the m-lines it leaves out are rejected (RFC 3264 section 6 asks for the offer's m-line count)",
  },
  "glare: the polite peer takes the remote offer": {
    result: "ok",
    basis:
      "W3C implicit rollback of have-local-offer; develop: accepted, communicates",
  },
  [FIRST_PRANSWER_REPLACED]: {
    result: "ok",
    basis:
      "werift extension: a local offer in have-remote-pranswer after a first pranswer connected",
  },
};

/** First negotiation answered by a pranswer that connects, then replaced. */
async function initialPranswerReplacement(api: any) {
  const a = new api.RTCPeerConnection();
  const b = new api.RTCPeerConnection();
  const track = new api.MediaStreamTrack({ kind: "audio" });
  a.addTransceiver(track, { direction: "sendonly" });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  const pranswer = (await b.createAnswer()).sdp;
  await b.setLocalDescription({ type: "pranswer", sdp: pranswer });
  await a.setRemoteDescription({ type: "pranswer", sdp: pranswer });
  await sleep(1500);
  let result = "ok";
  try {
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
  } catch (error) {
    result = (error as Error).name;
  }
  let received = false;
  const mid = a.getTransceivers()[0].mid;
  const remote = b.getTransceivers().find((t: any) => t.mid === mid);
  remote?.receiver.track.onReceiveRtp.subscribe(() => {
    received = true;
  });
  for (let i = 0; i < 15 && !received; i++) {
    track.writeRtp(
      new api.RtpPacket(new api.RtpHeader(), Buffer.from("x")).serialize(),
    );
    await sleep(200);
  }
  await Promise.allSettled([a.close(), b.close()]);
  return { result, comm: { tracks: { "a:audio": received } } };
}

async function main() {
  const api = await loadApi(root);
  const results: Record<string, unknown> = {};
  for (const [name, scenario] of Object.entries(scenarios)) {
    const ctx = await session(api);
    let result = "ok";
    let comm: unknown;
    try {
      const { act, after } = await withTimeout(
        Promise.resolve(scenario(ctx)),
        10000,
      );
      try {
        await withTimeout(act(), 5000);
      } catch (error) {
        result = (error as Error).name;
      }
      if (result === "ok" && after) {
        await withTimeout(after(), 5000).catch(
          (error) => (comm = `after failed: ${(error as Error).name}`),
        );
      }
      if (!comm) comm = await communication(ctx, name.slice(0, 8));
    } catch (error) {
      result = `arrange failed: ${(error as Error).message}`;
    } finally {
      await Promise.allSettled([ctx.a.pc.close(), ctx.b.pc.close()]);
    }
    results[name] = { result, comm };
  }
  results[FIRST_PRANSWER_REPLACED] = await initialPranswerReplacement(api);
  let mismatches = 0;
  for (const [name, row] of Object.entries(results)) {
    const expected = contract[name];
    const { result, comm } = row as { result: string; comm: unknown };
    // An accepted row must also communicate afterwards (rule (b)).
    const matches =
      result === expected?.result && (result !== "ok" || communicates(comm));
    if (!matches) mismatches++;
    results[name] = { ...(row as object), contract: expected, matches };
  }
  console.log(JSON.stringify(results, null, 1));
  process.exit(args.has("check") && mismatches > 0 ? 1 : 0);
}

void main();
