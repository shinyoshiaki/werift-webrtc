/**
 * addTrack() after a trackless sending slot was negotiated by an answer or a
 * pranswer (run by scenarios.ts). Each row declares the intended difference:
 * the shape HEAD must have and the shape of develop without the change
 * (`--expect develop`). The `control` rows never negotiated a sending
 * direction and have one shape for both.
 */
import { type Api, type Pc, rtpArrives } from "./lib";

/** What addTrack() and the following negotiation produced. */
export type AddTrackShape = {
  /** The sender addTrack() returned: the slot's, or a new one. */
  sender: "slot" | "new";
  /** getTransceivers().length of the peer that called addTrack(). */
  transceivers: number;
  /** getTransceivers().length of the other peer. */
  remoteTransceivers: number;
  /** m-lines of the offer created after addTrack(). */
  mLines: number;
};

const REUSED: AddTrackShape = {
  sender: "slot",
  transceivers: 1,
  remoteTransceivers: 1,
  mLines: 1,
};
const CREATED: AddTrackShape = {
  sender: "new",
  transceivers: 2,
  remoteTransceivers: 2,
  mLines: 2,
};

async function offerTo(offerer: Pc, answerer: Pc) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
}

async function answerTo(
  offerer: Pc,
  answerer: Pc,
  type: "answer" | "pranswer" = "answer",
  sdp?: string,
) {
  const answer = sdp ?? (await answerer.createAnswer()).sdp;
  await answerer.setLocalDescription({ type, sdp: answer });
  await offerer.setRemoteDescription(answerer.localDescription);
  return answer;
}

async function negotiate(offerer: Pc, answerer: Pc) {
  await offerTo(offerer, answerer);
  await answerTo(offerer, answerer);
}

async function rollback(offerer: Pc, answerer: Pc) {
  await offerer.setLocalDescription({ type: "rollback" });
  await answerer.setRemoteDescription({ type: "rollback" });
}

/** The peer that calls addTrack() and the trackless transceiver it has. */
type Slot = { adder: Pc; other: Pc; slot: any };

/**
 * `a`'s slot; with `send` false it is negotiated, and `b` (recvonly) never
 * sends on its side of it.
 */
async function offererSlot(a: Pc, b: Pc, direction?: string): Promise<Slot> {
  const slot = a.addTransceiver("audio", direction ? { direction } : {});
  return { adder: a, other: b, slot };
}

/** `b`'s transceiver of `a`'s offer, set to send without a track. */
async function pendingAnswererSlot(a: Pc, b: Pc): Promise<Slot> {
  a.addTransceiver("audio");
  await offerTo(a, b);
  const [slot] = b.getTransceivers();
  slot.direction = "sendrecv";
  return { adder: b, other: a, slot };
}

/** `b`'s slot negotiated recvonly, then a new offer it is about to send on. */
async function reofferedAnswererSlot(a: Pc, b: Pc): Promise<Slot> {
  a.addTransceiver("audio");
  await negotiate(a, b);
  await offerTo(a, b);
  const [slot] = b.getTransceivers();
  slot.direction = "sendrecv";
  return { adder: b, other: a, slot };
}

type Row = {
  prepare: (a: Pc, b: Pc) => Promise<Slot>;
  control?: boolean;
  /** The reused slot stays inactive at the peer: no media on develop. */
  silentOnDevelop?: boolean;
};

const rows: { [name: string]: Row } = {
  "addTrack: sendrecv slot, remote answer": {
    async prepare(a, b) {
      const slot = await offererSlot(a, b);
      await negotiate(a, b);
      return slot;
    },
  },
  "addTrack: sendonly slot, remote answer": {
    async prepare(a, b) {
      const slot = await offererSlot(a, b, "sendonly");
      await negotiate(a, b);
      return slot;
    },
  },
  "addTrack: answerer slot, local answer": {
    async prepare(a, b) {
      const slot = await pendingAnswererSlot(a, b);
      await answerTo(a, b);
      return slot;
    },
  },
  "addTrack: sending slot made inactive by the peer's re-offer": {
    silentOnDevelop: true,
    async prepare(a, b) {
      const slot = await offererSlot(a, b, "sendonly");
      await negotiate(a, b);
      b.getTransceivers()[0].direction = "inactive";
      await negotiate(b, a);
      return slot;
    },
  },
  "addTrack: remote pranswer, then the final answer": {
    async prepare(a, b) {
      const slot = await offererSlot(a, b);
      await offerTo(a, b);
      const sdp = await answerTo(a, b, "pranswer");
      await answerTo(a, b, "answer", sdp);
      return slot;
    },
  },
  "addTrack: remote pranswer, then rollback": {
    async prepare(a, b) {
      const slot = await offererSlot(a, b);
      await offerTo(a, b);
      await answerTo(a, b, "pranswer");
      await rollback(a, b);
      return slot;
    },
  },
  "addTrack: local pranswer, then the final answer": {
    async prepare(a, b) {
      const slot = await pendingAnswererSlot(a, b);
      const sdp = await answerTo(a, b, "pranswer");
      await answerTo(a, b, "answer", sdp);
      return slot;
    },
  },
  "addTrack: local pranswer on a re-offer, then rollback": {
    async prepare(a, b) {
      const slot = await reofferedAnswererSlot(a, b);
      await answerTo(a, b, "pranswer");
      await rollback(a, b);
      return slot;
    },
  },
  "addTrack control: unnegotiated slot": {
    control: true,
    prepare: (a, b) => offererSlot(a, b),
  },
  "addTrack control: negotiated recvonly slot": {
    control: true,
    async prepare(a, b) {
      const slot = await offererSlot(a, b, "recvonly");
      await negotiate(a, b);
      return slot;
    },
  },
  "addTrack control: recvonly transceiver of a remote offer": {
    control: true,
    async prepare(a, b) {
      a.addTransceiver("audio");
      await negotiate(a, b);
      return { adder: b, other: a, slot: b.getTransceivers()[0] };
    },
  },
};

export function addTrackContract(expect: "head" | "develop") {
  return Object.fromEntries(
    Object.entries(rows).map(([name, { control, silentOnDevelop }]) => [
      name,
      {
        result: "ok",
        silent: expect === "develop" && !!silentOnDevelop,
        shape: control || expect === "develop" ? REUSED : CREATED,
        basis: control
          ? "never negotiated sending: reused, as develop does"
          : "W3C addTrack: a sender once negotiated sending is not reused; develop (track-dependent flag) reuses it",
      },
    ]),
  );
}

async function runRow(api: Api, { prepare }: Row) {
  const a = new api.RTCPeerConnection();
  const b = new api.RTCPeerConnection();
  try {
    const { adder, other, slot } = await prepare(a, b);
    const track = new api.MediaStreamTrack({ kind: "audio" });
    const stream = new api.MediaStream({ id: "voice", tracks: [track] });
    const sender = adder.addTrack(track, stream);
    await adder.setLocalDescription(await adder.createOffer());
    const offer: string = adder.localDescription.sdp;
    await other.setRemoteDescription(adder.localDescription);
    await answerTo(adder, other);
    const transceiver = adder
      .getTransceivers()
      .find((t: any) => t.sender === sender);
    const remote = other
      .getTransceivers()
      .find((t: any) => t.mid === transceiver.mid);
    const section = offer
      .split(/^(?=m=)/m)
      .slice(1)
      .find((m) => m.includes(`a=mid:${transceiver.mid}\r\n`));
    const shape: AddTrackShape = {
      sender: sender === slot.sender ? "slot" : "new",
      transceivers: adder.getTransceivers().length,
      remoteTransceivers: other.getTransceivers().length,
      mLines: offer.match(/^m=/gm)?.length ?? 0,
    };
    return {
      result: "ok",
      shape,
      msid: section?.match(/^a=msid:(\S+)/m)?.[1],
      comm: {
        tracks: {
          [`added:${transceiver.mid}`]: await rtpArrives(
            api,
            track,
            remote.receiver.track,
            "voice",
          ),
        },
      },
    };
  } catch (error) {
    return { result: `${(error as Error).name}: ${(error as Error).message}` };
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
}

export async function runAddTrackScenarios(api: Api) {
  const results: { [name: string]: Awaited<ReturnType<typeof runRow>> } = {};
  for (const [name, row] of Object.entries(rows)) {
    results[name] = await runRow(api, row);
  }
  return results;
}
