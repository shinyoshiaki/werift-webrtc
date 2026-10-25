import { propertySeeds } from "../shared/seeds";
import {
  type Generator,
  type Judge,
  episodes,
  judgeCommit,
  judgeCreate,
  judgeIce,
  judgePending,
  judgeReject,
  judgeRollback,
  judgeTrickle,
  randomEpisode,
  randomIceEpisode,
  runScenario,
  scenario,
  seededRandom,
} from "./scenarios";

/**
 * Scenario property test: one property per claim of the negotiation
 * transaction (`scenario/scenarios.ts` has the judgements and the
 * scenario text format). Each property runs its fixed scenes, the scenes of
 * the individual tests it replaced (named after them; `(o=a)` / `(o=b)`
 * runs a scene once per offerer), and random scenarios from seeds. Every
 * operation is followed by the base checks (declared outcome, invariants of
 * both peers, JSEP transition) and the property's judgement; every scenario
 * ends with `expectSessionContinues`.
 *
 * CI runs `WERIFT_NEGOTIATION_SCENARIO_SEEDS` (default 1) seeds of
 * `WERIFT_NEGOTIATION_SCENARIO_STEPS` (default 4) episodes per property
 * from `WERIFT_NEGOTIATION_SCENARIO_SEED` (default 1). A failure prints the
 * seed, the input operations and the operation log; that seed replays them.
 */
const {
  seeds,
  steps: stepCount,
  replay,
} = propertySeeds("WERIFT_NEGOTIATION_SCENARIO", { seeds: 1, steps: 4 });

/** Fixed scenes by name; `o` / `t` in a scene marked `(o=…)` is the offerer / answerer. */
type Fixed = Record<string, string>;
const perOfferer = (scenes: Fixed): Fixed =>
  Object.fromEntries(
    Object.entries(scenes).flatMap(([name, text]) =>
      (["a", "b"] as const).map((o) => [
        `${name} (o=${o})`,
        text.replace(/\bo\b/g, o).replace(/\bt\b/g, o === "a" ? "b" : "a"),
      ]),
    ),
  );

const mmsPranswers = `o createOffer; o setLocal offer
  t setRemote offer edit=mms:131072
  t reply pranswer remote=mms:98304
  t reply pranswer reuse remote=mms:81920; alive`;
const inactivePranswer = `a offer; b reply pranswer edit=inactive; alive silent`;
const reappliedAudioOffer = `a addTransceiver audio; a createOffer; a setLocal offer
  a setLocal rollback; a setLocal offer; b setRemote local:a; b reply; alive`;
const remoteRestartTrickle = `a createOffer
  b setRemote offer edit=ufrag:newgeneration123
  b addCandidate remote:b synthetic=pending; alive
  b createAnswer; b setLocal answer type=pranswer; alive
  b setRemote rollback; alive`;
const flippedSetup = (
  type: string,
) => `a offer; b createAnswer; b setLocal answer
  a setRemote answer type=${type} edit=flipSetup reject=InvalidModificationError
  alive; a setLocal rollback; alive`;
const savedRestartAnswer = (meanwhile: string) => `a restartIce; a offer
  b createAnswer as=saved; ${meanwhile}
  b setLocal saved; a setRemote local:b; nominated; alive`;

const properties: {
  claim: string;
  judge: Judge;
  generate: Generator;
  fixed: Fixed;
}[] = [
  {
    claim:
      "the final answer commits the directions both applications asked for",
    judge: judgeCommit,
    generate: episodes((rng) =>
      randomEpisode(rng, { audio: true, finish: ["answer"] }),
    ),
    fixed: {
      ...perOfferer({
        "Matrix: replacement pranswer and a different final answer": `o offer
          t reply pranswer; alive; t reply pranswer reuse edit=recvonly; alive
          t reply reuse; alive`,
        "Matrix: replacement offer and implicit rollback of a glare offer": `t createOffer; t setLocal offer
          o createOffer as=first; o setLocal first; t setRemote first; alive
          o negotiate; alive`,
        "Matrix: SCTP max-message-size changes commit on the existing association":
          "o negotiate edit=mms:131072; alive",
        "Matrix: renegotiation max-message-size follows offer, pranswers and answer": `${mmsPranswers}
          t reply reuse remote=mms:262144; alive`,
        "CoverageTransport [2.9-T8]: the same offer replaces a renegotiation pranswer in have-remote-pranswer": `o createOffer; o setLocal offer; t setRemote offer
          t reply pranswer edit=inactive; o setLocal offer; alive
          t setRemote offer; t reply; alive`,
      }),
      "EffectiveValues: an inactive pranswer stops sending until a sendrecv answer": `${inactivePranswer}
        b reply reuse; alive`,
      "Regression: an offer created while a remote offer was pending can be applied after stable and negotiates its new audio": `b addTransceiver audio; a offer
        b createAnswer as=savedAnswer; b createOffer as=savedOffer
        b setLocal savedAnswer; a setRemote local:b
        b setLocal savedOffer; a setRemote local:b; a reply; alive`,
      "Regression: re-applying the same offer after its rollback negotiates the new audio it carries":
        reappliedAudioOffer,
    },
  },
  {
    claim:
      "a pending negotiation keeps the transports of the committed session",
    judge: judgePending,
    generate: episodes((rng) =>
      randomEpisode(rng, { audio: true, pendingAlive: 0.7 }),
    ),
    fixed: {
      "negotiationTransaction: remote ICE restart offer and pending trickle leave the current RTP path alive through rollback":
        remoteRestartTrickle,
    },
  },
  {
    claim: "rollback returns a peer to the state before the negotiation",
    judge: judgeRollback,
    generate: episodes((rng) =>
      randomEpisode(rng, {
        audio: true,
        addDuring: 0.3,
        finish: ["rollback", "rollback", "answer"],
      }),
    ),
    fixed: {
      ...perOfferer({
        "Matrix: re-offer commits by answer and rolls back to the same current":
          "o offer; alive; o rollback; alive; o negotiate; alive",
        "Matrix: pranswer followed by rollback restores the current session":
          "o offer; t reply pranswer; o rollback; alive",
        "Matrix: renegotiation max-message-size follows offer, pranswers and rollback": `${mmsPranswers}
          o rollback; alive`,
        "Matrix: local ICE restart then rollback":
          "o offer restart; alive; o rollback; alive",
      }),
      "EffectiveValues: an inactive pranswer stops sending until a sendrecv rollback": `${inactivePranswer}
        a rollback; alive`,
      "negotiationTransaction: remote ICE restart offer and pending trickle leave the current RTP path alive through rollback":
        remoteRestartTrickle,
      "negotiationTransaction: a pranswer that flips the DTLS setup of a connected association is rejected and the role survives rollback":
        flippedSetup("pranswer"),
      "negotiationTransaction: an answer that flips the DTLS setup of a connected association is rejected and the role survives rollback":
        flippedSetup("answer"),
      "Regression: rollback of a replacement local offer takes back the MID it gave a transceiver added meanwhile": `a createOffer; a setLocal offer
        a addTransceiver video bare; a createOffer; a setLocal offer
        a setLocal rollback`,
      "Regression: re-applying the same offer after its rollback negotiates the new audio it carries":
        reappliedAudioOffer,
      // seeds 52 / 150 / 240 (300-seed search): a transceiver added meanwhile
      // kept what a pranswer negotiated for it, and a later offer reusing it
      // carried no RTP.
      "regression: rollback after a pranswer returns a transceiver added meanwhile to its created state": `b createOffer; b setLocal offer; a setRemote local:b
        b addTransceiver video bare; b offer restart
        a reply pranswer edit=inactive; b rollback; alive`,
      // seed 15 (4 steps): after a remote pranswer the transceiver kept the MID.
      "regression: rollback after a pranswer takes back the MID a replacement offer gave a transceiver added meanwhile": `a createOffer; a setLocal offer
        a addTransceiver video bare; a offer; b reply pranswer
        a rollback; alive`,
    },
  },
  {
    claim: "a rejected description operation changes neither peer",
    judge: judgeReject,
    generate: episodes((rng) =>
      randomEpisode(rng, { audio: true, invalid: 0.5 }),
    ),
    fixed: {
      ...perOfferer({
        "Matrix: validation failures leave current and pending untouched": `o createOffer; o setLocal offer
          t setRemote offer edit=ptRemap reject=InvalidModificationError
          t setRemote offer edit=fingerprint reject=InvalidModificationError
          t setRemote offer edit=sctpPort reject=InvalidModificationError
          alive; t setRemote offer; t createAnswer; t setLocal answer
          o setRemote answer edit=ptRemap reject=InvalidModificationError
          alive; o setRemote answer; alive`,
        "CoverageTransport [2.4-8]: a local pranswer that flips the DTLS setup of a connected association is rejected": `o offer; t createAnswer
          t setLocal answer type=pranswer edit=flipSetup reject=InvalidModificationError message=DTLS.role
          alive; t setLocal answer type=pranswer; t setLocal answer
          o setRemote answer; alive`,
      }),
      "negotiationTransaction: a connected DTLS fingerprint change / existing SCTP port change / MID change (validation failure) of an unapplied offer is rejected": `a createOffer
        b setRemote offer edit=fingerprint reject=InvalidModificationError
        b setRemote offer edit=sctpPort reject=InvalidModificationError
        b setRemote offer edit=midWrong reject=InvalidModificationError
        alive`,
      "negotiationTransaction: an answer MID with a suffix is rejected before any state changes": `a offer; b createAnswer; b setLocal answer
        a setRemote answer edit=midSuffix reject=InvalidModificationError|OperationError
        alive; a setRemote answer; alive`,
      "negotiationTransaction: an answer BUNDLE member with a suffix is rejected before any state changes": `a offer; b createAnswer; b setLocal answer
        a setRemote answer edit=bundleSuffix reject=InvalidModificationError|OperationError
        alive; a setRemote answer; alive`,
      "negotiationTransaction: a pranswer that flips the DTLS setup of a connected association is rejected and the role survives rollback":
        flippedSetup("pranswer"),
      "negotiationTransaction: an answer that flips the DTLS setup of a connected association is rejected and the role survives rollback":
        flippedSetup("answer"),
      "negotiationTransaction: a replacement offer that would move SCTP is rejected before retiring the pending offer": `a offer
        b setRemote local:a edit=noBundle reject=InvalidModificationError
        b reply; alive`,
      "Regression: a local answer that flips the DTLS setup of a connected association is rejected": `a offer; b createAnswer
        b setLocal answer edit=flipSetup reject=InvalidModificationError
        b setLocal answer; a setRemote local:b; alive`,
      "CoverageTransport [2.2-19]: a stable session after the final answer cannot be rolled back": `a negotiate
        a setLocal rollback reject=InvalidStateError
        a setRemote rollback reject=InvalidStateError
        b setLocal rollback reject=InvalidStateError
        b setRemote rollback reject=InvalidStateError; alive`,
    },
  },
  {
    claim: "a trickled candidate joins its own generation's description once",
    judge: judgeTrickle,
    generate: episodes((rng) => randomEpisode(rng, { trickle: 0.8 })),
    fixed: {
      ...perOfferer({
        "Matrix: pending trickle, duplicate candidate/EOC and a late old-generation candidate": `save local:o as=old
          o createOffer restart; o setLocal offer
          t setRemote local:o edit=noCandidates
          t addCandidate local:o twice; t endOfCandidates twice; alive
          t reply; nominated; t addCandidate old reject=either; alive`,
      }),
      // seed 2 (4 steps): the restart offer's description repeated "candidate:".
      "regression: an ICE restart offer describes and trickles candidates with a plain foundation": `b createOffer restart; b setLocal offer
        a setRemote local:b edit=noCandidates; a addCandidate local:b twice
        a reply; nominated; alive`,
      "negotiationTransaction: replacement offer discards earlier pending trickle while keeping the baseline": `a createOffer; b setRemote offer
        b addCandidate offer synthetic=oldpending
        b setRemote offer edit=ufrag:replacement123; alive
        b setRemote rollback`,
    },
  },
  {
    claim: "ICE credentials follow restart requests until a commit",
    judge: judgeIce,
    generate: episodes(randomIceEpisode),
    fixed: {
      ...perOfferer({
        "Matrix: local ICE restart then answer":
          "o offer restart; alive; t reply; nominated; alive",
      }),
      "negotiationTransaction: an unapplied createOffer() keeps the restart credentials of the applied pending offer": `a createOffer restart; a setLocal offer
        a createOffer as=unapplied; b setRemote local:a; b reply; nominated; alive`,
      "negotiationTransaction: an unapplied createOffer({ iceRestart: true }) keeps the restart credentials of the applied pending offer": `a createOffer restart; a setLocal offer
        a createOffer restart as=unapplied; b setRemote local:a; b reply
        nominated; alive`,
      "CoverageIce [5-9]: a restartIce() request survives the implicit rollback of a glare until an answer commits new credentials": `a restartIce; a createOffer; a setLocal offer
        b negotiate; a offer as=retry; b reply; nominated
        a createOffer as=next; alive`,
      "CoverageIce [5-9]: an offer created after restartIce() while a restart offer is pending replaces the pending credentials too": `a createOffer restart; a setLocal offer
        a restartIce; a offer as=retry; b reply; nominated
        a createOffer as=next; alive`,
      "Regression: a restartIce() request survives a rolled-back offer until an answer commits new credentials": `a restartIce; a createOffer as=first; a setLocal first
        a setLocal rollback; a offer as=retry; b reply; nominated
        a createOffer as=next; alive`,
      "Regression: restartIce() while a restart offer is pending also replaces the pending credentials": `a createOffer restart; a setLocal offer; a restartIce
        b setRemote local:a; b reply; nominated; alive
        a createOffer as=retry`,
      "Regression: an ICE restart answer saved before createAnswer() ran again can still be applied":
        savedRestartAnswer("b createAnswer"),
      "Regression: an unapplied createOffer({ iceRestart: true }) does not discard the restart generation of a saved answer":
        savedRestartAnswer("b createOffer restart as=unapplied"),
      "Regression: an unapplied restartIce() + createOffer() does not discard the restart generation of a saved answer":
        savedRestartAnswer("b restartIce; b createOffer as=unapplied"),
      "Regression: an answer created again after an unapplied restart offer keeps the saved answer's generation":
        savedRestartAnswer(
          "b createOffer restart as=unapplied; b createAnswer",
        ),
      "Regression: a saved ICE restart offer re-applied after its rollback commits its generation (video only)": `a createOffer restart as=saved; a setLocal saved
        a setLocal rollback; a setLocal saved; b setRemote local:a; b reply
        nominated; alive`,
      "Regression: a saved ICE restart offer re-applied after its rollback commits its generation (with a new audio)": `a addTransceiver audio
        a createOffer restart as=saved; a setLocal saved
        a setLocal rollback; a setLocal saved; b setRemote local:a; b reply
        nominated; alive`,
      "Regression: a saved restart offer re-applied after the peer committed another restart still restarts to its generation": `a addTransceiver audio
        a createOffer restart as=saved; a setLocal saved; a setLocal rollback
        b restartIce; b negotiate; nominated
        a setLocal saved; b setRemote local:a; b reply; nominated; alive`,
      "Regression: the latest restart offer, committed once, applies again after the peer committed another restart": `a createOffer restart as=saved; a setLocal saved
        b setRemote local:a; b reply; nominated
        b restartIce; b negotiate; nominated
        a setLocal saved; b setRemote local:a; b reply; nominated; alive`,
    },
  },
  {
    claim: "creating an offer or answer changes nothing",
    judge: judgeCreate,
    generate: episodes((rng) => [
      ...randomEpisode(rng, { audio: true }),
      `${rng.pick(["a", "b"])} createOffer as=unapplied`,
    ]),
    fixed: {
      "Regression: an offer created while a remote offer is pending keeps the MIDs and m-line positions it associated": `b addTransceiver audio bare; a offer
        b createAnswer as=saved; b createOffer as=unapplied
        b setLocal saved; a setRemote local:b; alive`,
    },
  },
];

describe.concurrent.each(properties)(
  "negotiation scenario property: $claim",
  ({ judge, generate, fixed }) => {
    test.each(Object.entries(fixed))(
      "fixed: %s",
      // Act / Assert: 固定の操作列を実行し、各操作の後に基本検査と property の判定を行う。
      (name, text) => runScenario(`fixed: ${name}`, scenario(text), judge),
      60_000,
    );

    test.each(seeds)(
      "seed %i",
      // Act / Assert: seed から生成した操作列を実行し、同じ判定を行う。
      (seed) =>
        runScenario(
          `seed ${seed} (replay: ${replay(seed)})`,
          generate(seededRandom(seed), stepCount),
          judge,
        ),
      120_000,
    );
  },
);
