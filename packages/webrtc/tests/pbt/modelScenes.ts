import type { Scene } from "./modelPropertyUtils";

/**
 * Fixed scenes of the model property: the operation sequences of former
 * individual tests (named in `ref`) and of regressions, as short lists. The
 * oracles judge them like any random scene. In `connected` scenes the
 * duplex session has video (MID 0) and a DataChannel (MID 1), so the first
 * added m-line gets MID 2 and transceiver index 1.
 */
export const MODEL_SCENES: (Scene & { name: string; ref: string })[] = [
  {
    name: "a DataChannel created during a first offer survives its rollback and opens at the next negotiation",
    ref: "2.3-15 2.3-17 2.3-18; was NT rollback keeps a DataChannel created $when",
    start: "unnegotiated",
    ops: [
      ["a", "offer"],
      ["a", "dataChannel"],
      ["a", "rollback"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a DataChannel the answerer creates in have-remote-offer survives the rollback",
    ref: "2.3-15 2.3-17; was NT rollback keeps a DataChannel created in have-remote-offer",
    start: "unnegotiated",
    ops: [
      ["a", "offer"],
      ["b", "dataChannel"],
      ["b", "rollback"],
      ["b", "offer"],
      ["a", "answer"],
    ],
  },
  {
    name: "a DataChannel created between createOffer and applying that older offer",
    ref: "2.3-15 2.9-10; was NT … between createOffer and setting that older offer, Reg a first offer with a DataChannel re-applied after its rollback",
    start: "unnegotiated",
    ops: [
      ["a", "createOnly"],
      ["a", "dataChannel"],
      ["a", "applyStale"],
      ["a", "rollback"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a renegotiation pranswer carries a new stream beside the committed one and rollback removes it",
    ref: "2.1-3 2.2-1 2.2-16; was NT re-offer pranswer carries new RTP alongside the committed stream, CovT [2.2-16]",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer"],
      ["b", "pranswer"],
      ["a", "rollback"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "channels of a committed association stay open through a pranswer and its rollback",
    ref: "5-4; was CovE [5-4]",
    start: "connected",
    ops: [
      ["a", "offer"],
      ["b", "pranswer"],
      ["a", "dataChannel"],
      ["a", "rollback"],
    ],
  },
  {
    name: "a replacement offer keeps a new transceiver on its m-line",
    ref: "2.1-T5; origin: property test; was Reg a replacement local offer keeps a new transceiver associated with its m-line",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer"],
      ["a", "replacementOffer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a replacement offer implicitly rolls back a first pranswer connection",
    ref: "2.1-6 2.1-T12 2.9-T8; was NT replacement offers implicitly roll back either pranswer direction, CovT [2.9-T8]",
    start: "unnegotiated",
    ops: [
      ["a", "offer"],
      ["b", "pranswer"],
      ["a", "replacementOffer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a first pranswer connects provisionally and its rollback lets the next negotiation connect",
    ref: "2.1-T1 2.1-T4 2.3-16; was NT initial pranswer carries provisional RTP / DataChannel traffic",
    start: "unnegotiated",
    ops: [
      ["b", "addTrack", { kind: "video" }],
      ["a", "offer"],
      ["b", "pranswer"],
      ["a", "rollback"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a sender added during a rolled-back offer carries traffic after the next negotiation",
    ref: "5-8; origin: self-review (live state); was Reg a sender added during a rolled-back offer keeps receiving RTCP",
    start: "connected",
    ops: [
      ["a", "offer"],
      ["a", "addTrack", { kind: "video" }],
      ["a", "rollback"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a local ICE restart and a restart pranswer roll back to the committed generation",
    ref: "2.1-T8 2.7-T2; was NT local ICE restart rollback retains the committed selected pair, ICE restart pranswer … then rollback",
    start: "connected",
    ops: [
      ["a", "offer", { iceRestart: true }],
      ["a", "rollback"],
      ["a", "offer", { iceRestart: true }],
      ["b", "pranswer"],
      ["a", "rollback"],
    ],
  },
  {
    name: "a restart pranswer is committed by the final answer",
    ref: "2.1-T7 2.7-T4a; was NT ICE restart pranswer … then answer, both peers commit matching ICE restart generations",
    start: "connected",
    ops: [
      ["a", "offer", { iceRestart: true }],
      ["b", "pranswer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a stopped m-line is rejected and a later transceiver reuses it",
    ref: "2.1-T10; was Matrix transceiver stop rejects its m-line and a later transceiver reuses it",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer"],
      ["b", "answer"],
      ["a", "stop", { index: 1 }],
      ["a", "offer"],
      ["b", "answer"],
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "a local BUNDLE split carries both streams, and its rollback keeps the old owner",
    ref: "2.1-T9 2.5-11 2.5-12; was NT a local BUNDLE split prepares independent ICE …, rollback of a local BUNDLE split keeps the old RTP owner, re-offer BUNDLE split stages a new owner",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer"],
      ["b", "answer"],
      ["a", "splitOffer", { mid: "2" }],
      ["a", "rollback"],
      ["a", "splitOffer", { mid: "2" }],
      ["b", "answer"],
    ],
  },
  {
    name: "duplicate trickle candidates and end-of-candidates change nothing",
    ref: "2.1-10 2.3-21; was NT duplicate trickle candidate and EOC are idempotent within one generation",
    start: "connected",
    ops: [
      ["a", "offer"],
      ["b", "trickle", { twice: true, end: true }],
      ["b", "reapplyRemote"],
      ["b", "answer"],
    ],
  },
  {
    name: "MIDs an unapplied createOffer reserved do not collide with a later remote offer",
    ref: "origin: property test; was Reg MIDs from unapplied createOffer calls do not collide with a later remote offer",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "createOnly"],
      ["b", "addTrack", { kind: "audio" }],
      ["b", "offer"],
      ["a", "answer"],
    ],
  },
  {
    name: "glare: a remote offer implicitly rolls back the local one",
    ref: "2.1-T12; was Scen glare scenes",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "video" }],
      ["a", "glare"],
      ["a", "answer"],
    ],
  },
  {
    name: "a replacement remote offer does not notify the track of an existing transceiver again",
    ref: "2.1-T6 2.3-4; origin: model property (seeds 9 and 27): the implicit rollback reset the delivered track",
    start: "unnegotiated",
    ops: [
      ["b", "addTrack", { kind: "video" }],
      ["b", "offer"],
      ["b", "replacementOffer"],
      ["a", "answer"],
    ],
  },
  {
    name: "the first SCTP transport a DataChannel creates during an offer survives its rollback",
    ref: "2.3-15 2.3-17; was NT rollback keeps a DataChannel created in have-local-offer (offerer without a DataChannel)",
    start: "media",
    ops: [
      ["a", "offer"],
      ["a", "dataChannel"],
      ["a", "rollback"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "an SCTP MID an unapplied createOffer reserved follows the MID of the peer's offer",
    ref: "2.9-4; origin: model property (seed 186): the answer repeated MID 0 (develop sent it, HEAD rejected it)",
    start: "unnegotiated",
    ops: [
      ["b", "offer", { iceRestart: true }],
      ["b", "dataChannel"],
      ["b", "createOnly"],
      ["a", "answer"],
      ["a", "offer"],
      ["b", "answer"],
    ],
  },
  {
    name: "an answer rejects the m-line of a stopping transceiver whose codec preferences left no codec",
    ref: "2.1-T10 2.5-4; origin: model property (seed 264): the answer had an m-line without formats (also in develop)",
    start: "unnegotiated",
    ops: [
      ["b", "addTrack", { kind: "audio" }],
      ["b", "addTrack", { kind: "video" }],
      ["a", "glare"],
      ["a", "answer"],
      ["b", "codecPreferences", { index: 1, codec: "video/VP8" }],
      ["b", "stop", { index: 1 }],
      ["a", "offer"],
      ["b", "answer"],
      ["b", "offer"],
      ["a", "answer"],
    ],
  },
];
