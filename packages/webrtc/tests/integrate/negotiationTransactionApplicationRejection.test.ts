import { describe, expect } from "vitest";

import { negotiationCases } from "./negotiationCaseRunner";
import {
  type DuplexSession,
  createMutationSession,
  enforceSessionContinuation,
  expectDataAlive,
  expectSessionContinues,
  leaveBundle,
  mungeSection,
  prepareMutationAnswerer,
  sectionOf,
  step,
  negotiationTest as test,
  waitForMutationSession,
} from "./negotiationTransactionUtils";

const APPLICATION = "1";

/** `sdp` with the application m-line `mid` rejected (port 0, out of BUNDLE). */
const rejectApplication = (sdp: string, mid = APPLICATION) =>
  leaveBundle(
    mungeSection(sdp, mid, (section) =>
      section.replace(/^m=application \d+/m, "m=application 0"),
    ),
    mid,
  );

/** The port of the application m-line `mid` in `sdp`. */
const applicationPort = (sdp: string, mid = APPLICATION) =>
  Number(/^m=application (\d+)/m.exec(sectionOf(sdp, mid))?.[1]);

type Path = {
  name: string;
  phase: "initial" | "renegotiation";
  /** Act: reject the application m-line on this path. */
  reject: (session: DuplexSession) => Promise<void>;
  /** The peer whose next offer is checked first (it saw the rejection). */
  next: "a" | "b";
  /** The DataChannel of the session keeps carrying data (develop behavior). */
  dataContinues: boolean;
};

/** Act: a offers; the offer (`munge`d, if given) reaches b, which prepares to answer. */
const offerReachesB = async (
  session: DuplexSession,
  munge?: (sdp: string) => string,
) => {
  const { a, b } = session;
  await step(session, async () =>
    a.pc.setLocalDescription(await a.pc.createOffer()),
  );
  const offer = a.pc.localDescription!;
  await step(session, () =>
    b.pc.setRemoteDescription(
      munge ? { type: "offer", sdp: munge(offer.sdp) } : offer,
    ),
  );
  await prepareMutationAnswerer(session);
};

/** Act: a offers; the answer from b reaches a with the application rejected. */
const answerRejects = async (session: DuplexSession) => {
  const { a, b } = session;
  await offerReachesB(session);
  await step(session, async () =>
    b.pc.setLocalDescription(await b.pc.createAnswer()),
  );
  await step(session, () =>
    a.pc.setRemoteDescription({
      type: "answer",
      sdp: rejectApplication(b.pc.localDescription!.sdp),
    }),
  );
};

/** Act: the offer from a reaches b with the application rejected; b answers. */
const offerRejects = async (session: DuplexSession) => {
  const { a, b } = session;
  await offerReachesB(session, rejectApplication);
  await step(session, async () =>
    b.pc.setLocalDescription(await b.pc.createAnswer()),
  );
  // b の answer は拒否された application を port 0 で返す (RFC 3264)。
  expect(applicationPort(b.pc.localDescription!.sdp)).toBe(0);
  await step(session, () => a.pc.setRemoteDescription(b.pc.localDescription!));
};

/**
 * Act: a pranswer that rejects the application, then a rolls back
 * (`rollback`) or the same final answer arrives (`answer`).
 */
const pranswerRejectsThen =
  (then: "rollback" | "answer") => async (session: DuplexSession) => {
    const { a, b } = session;
    await offerReachesB(session);
    const answer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      a.pc.setRemoteDescription({
        type: "pranswer",
        sdp: rejectApplication(answer),
      }),
    );
    if (then === "rollback") {
      await step(session, () =>
        a.pc.setLocalDescription({ type: "rollback" } as never),
      );
      await step(session, () =>
        b.pc.setRemoteDescription({ type: "rollback" } as never),
      );
      return;
    }
    await step(session, () =>
      b.pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({
        type: "answer",
        sdp: rejectApplication(answer),
      }),
    );
  };

const PATHS: Path[] = [
  {
    name: "initial answer rejects",
    phase: "initial",
    reject: answerRejects,
    next: "a",
    dataContinues: false,
  },
  {
    name: "renegotiation answer rejects",
    phase: "renegotiation",
    reject: answerRejects,
    next: "a",
    dataContinues: true,
  },
  {
    name: "initial remote offer rejects (answerer has no SCTP transport)",
    phase: "initial",
    reject: offerRejects,
    next: "b",
    dataContinues: false,
  },
  {
    name: "renegotiation remote offer rejects",
    phase: "renegotiation",
    reject: offerRejects,
    next: "b",
    dataContinues: true,
  },
  {
    name: "initial pranswer rejects, then the final answer rejects",
    phase: "initial",
    reject: pranswerRejectsThen("answer"),
    next: "a",
    dataContinues: false,
  },
  {
    name: "renegotiation pranswer rejects, then rollback",
    phase: "renegotiation",
    reject: pranswerRejectsThen("rollback"),
    next: "a",
    dataContinues: true,
  },
  {
    name: "renegotiation pranswer rejects, then the final answer rejects",
    phase: "renegotiation",
    reject: pranswerRejectsThen("answer"),
    next: "a",
    dataContinues: true,
  },
];

describe("a rejected application m-line keeps the session usable", () => {
  enforceSessionContinuation();

  test.for(PATHS)("$name", { timeout: 60000 }, async (path, { closing }) => {
    // Arrange: video と DataChannel を持つ session (初回は未交渉、再交渉は接続済み)。
    const session = closing(await createMutationSession(path.phase));
    const next = session[path.next].pc;
    const other = session[path.next === "a" ? "b" : "a"].pc;

    // Act: この経路で application m-line を拒否する。
    await path.reject(session);

    // Assert: 拒否の後も、次の offer を作って適用できる。
    const offer = await next.createOffer();
    const application = offer.sdp
      .split(/(?=^m=)/m)
      .filter((section) => section.startsWith("m=application"));
    // application m-line は位置を保ったまま 1 本だけ残る。
    expect(application).toHaveLength(1);
    expect(application[0]).toMatch(/^a=mid:\S+/m);
    if (next.sctpTransport) {
      // SCTP transport を持つ側は develop と同じく同じ MID で再提案する。
      expect(applicationPort(offer.sdp, next.sctpTransport.mid!)).not.toBe(0);
    } else {
      // SCTP transport のない側は拒否された位置を port 0 で保つ。
      expect(applicationPort(offer.sdp)).toBe(0);
    }

    // Assert: 次の offer・ICE restart・DataChannel と transceiver の追加・
    // 相手からの再 offer の後も通信できる。
    await expectSessionContinues(next, other, "after-application-reject");
    if (path.dataContinues) {
      // Assert: develop と同じく、元の DataChannel も閉じずに通信を続ける。
      expect(session.a.channel.readyState).toBe("open");
      await expectDataAlive(session, "original-channel");
    }
  });
});

negotiationCases(
  "a rejected application m-line keeps the session usable",
  [
    `
      case: an application created after the answerer rejected it takes the rejected position with a new MID
      ref: 2.11-1 2.11-4
      given: createMutationSession("initial")
      Arrange: 初回の remote offer で application を拒否し、SCTP transport を持たない answerer。
      a offer hold
      b setRemote rejectApplication(local(a).sdp)
      do prepareMutationAnswerer(session)
      b answer hold
      expect applicationPort(local(b).sdp) == 0
      a setRemote local(b)
      expect b.sctpTransport is undefined
      Act: answerer が DataChannel を作ってから offer を作る。
      do b.createDataChannel("late")
      b createOffer as=offer
      Assert: 拒否された位置 (index 1) を新しい MID で再利用し、port は 0 でない。
      let sections = offer.sdp.split(/(?=^m=)/m).slice(1)
      expect sections.length == 2
      expect sections[1] matches /^m=application [1-9]/
      let mid = /^a=mid:(\\S+)/m.exec(sections[1])[1]
      expect mid isnt undefined
      expect mid isnt "1"
      Assert: その offer で交渉した後も session を使い続けられる。
      b setLocal offer
      a setRemote local(b)
      a answer
      do waitForMutationSession(session)
    `,
  ],
  { fns: { rejectApplication, applicationPort } },
);
