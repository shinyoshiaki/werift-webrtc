import type { LeakScene } from "./leakProbe";

/**
 * Fixed scenes of the leak property: regressions of leaks it found and
 * scenes that cover the close paths. P1 scenes run a model-property scene
 * (`model/generator.ts` operations) and close both peers, optionally while
 * an operation runs (`interrupt`); P2 cycles name templates of
 * `CYCLE_TEMPLATES` repeated on one session.
 */
export const CLOSED_SCENES: (LeakScene & { name: string; ref: string })[] = [
  {
    name: "renegotiation with ICE restart, pranswer and rollback, then close",
    ref: "property: leak L1 L2",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer", { iceRestart: true }],
      ["b", "pranswer"],
      ["a", "rollback"],
      ["b", "offer", { iceRestart: false }],
      ["a", "answer"],
    ],
  },
  {
    name: "a replacement offer and a BUNDLE split, then close",
    ref: "property: leak L1 L2",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "video" }],
      ["a", "offer", { iceRestart: false }],
      ["b", "answer"],
      ["a", "splitOffer", { mid: "2" }],
      ["a", "replacementOffer", { iceRestart: true }],
      ["b", "answer"],
    ],
  },
  {
    name: "a BUNDLE split merged again, then close",
    ref: "property: leak L1 L2",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "video" }],
      ["a", "offer", { iceRestart: false }],
      ["b", "answer"],
      ["a", "splitOffer", { mid: "2" }],
      ["b", "answer"],
      ["a", "offer", { iceRestart: false }],
      ["b", "answer"],
      ["b", "splitOffer", { mid: "2" }],
      ["a", "answer"],
      ["b", "offer", { iceRestart: false }],
      ["a", "answer"],
    ],
  },
  {
    name: "closed while a BUNDLE split offer and its proposal's transports are pending",
    ref: "property: leak L1 L2; close in have-local-offer / have-remote-offer",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "video" }],
      ["a", "offer", { iceRestart: false }],
      ["b", "answer"],
      ["a", "splitOffer", { mid: "2" }],
    ],
    asIs: true,
  },
  {
    name: "closed while an offer pending on the answerer moved its DataChannel transport into BUNDLE",
    ref: "property: leak L1 L2; origin: seed 252 (a transport only the rollback baseline bound was never stopped)",
    start: "unnegotiated",
    ops: [
      ["b", "offer", { iceRestart: false }],
      ["b", "dataChannel"],
      ["b", "addTrack", { kind: "video" }],
      ["a", "answer"],
      ["b", "offer", { iceRestart: false }],
    ],
    asIs: true,
  },
  {
    name: "closed during a pranswer of an ICE restart",
    ref: "property: leak L1 L2; close in have-remote-pranswer / have-local-pranswer",
    start: "connected",
    ops: [
      ["a", "addTrack", { kind: "audio" }],
      ["a", "offer", { iceRestart: true }],
      ["b", "pranswer"],
    ],
    asIs: true,
  },
  {
    name: "a first negotiation closed while its answer is applied",
    ref: "property: leak L1 L2; close timing; origin: a STUN query to the default server started after close (its DNS lookup outlived the socket) and kept retransmitting",
    start: "media",
    ops: [["a", "offer", { iceRestart: false }]],
    interrupt: {
      side: "a",
      operation: "setRemoteDescription(answer)",
      ticks: 0,
    },
  },
  {
    name: "an ICE restart offer closed while it gathers",
    ref: "property: leak L1 L2; close timing",
    start: "connected",
    ops: [],
    interrupt: {
      side: "b",
      operation: "setLocalDescription(offer)",
      ticks: "macrotask",
    },
  },
];

/**
 * Fixed cycles of the session property (P2). Each found leak is a cycle
 * that grew a metric before its fix.
 */
export const LEAK_CYCLES: { name: string; ref: string; templates: string[] }[] =
  [
    {
      name: "a remote DataChannel that closed leaves the SCTP manager's list",
      ref: "property: leak L3; origin: sctpManager kept every remote channel",
      templates: ["remote DataChannel opened and closed"],
    },
    {
      name: "an ICE restart keeps the agent's credential history bounded",
      ref: "property: leak L3; origin: ice Connection.userHistory grew by two per restart",
      templates: ["ICE restart"],
    },
    {
      name: "a stopped sender releases its DTLS transport subscription",
      ref: "property: leak L3; origin: RTCRtpSender kept its onStateChange subscription on the BUNDLE transport",
      templates: ["transceiver added, stopped and its m-line reused"],
    },
    {
      name: "a stopped sender a glare rollback binds again does not subscribe to its transport",
      ref: "property: leak L3; origin: cycle seed 148 (rollback restored a stopped sender's DTLS subscription)",
      templates: ["transceiver added, stopped and its m-line reused", "glare"],
    },
    {
      name: "renegotiation, pranswer, replacement and glare reach a steady state",
      ref: "property: leak L3",
      templates: [
        "re-offer",
        "pranswer then final answer",
        "replacement offer then rollback",
        "glare",
      ],
    },
    {
      name: "BUNDLE split and merge, trickle and end-of-candidates reach a steady state",
      ref: "property: leak L3",
      templates: ["BUNDLE split and merge", "trickle and end-of-candidates"],
    },
  ];
