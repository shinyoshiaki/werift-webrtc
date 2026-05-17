import { peer, sleep, waitVideoPlay } from "../fixture";
import { createNativeCandidateQueue } from "../nativeCandidateQueue";

function attachCandidateHandler(
  label: string,
  pc: RTCPeerConnection,
  done: () => void,
) {
  const candidates = createNativeCandidateQueue(pc);
  const eventPeer = peer as typeof peer & {
    on: (
      event: "request",
        listener: (
          request: {
            method: string;
            data: { candidate: RTCIceCandidateInit | null };
          },
          accept: () => void,
        ) => void,
    ) => void;
    removeListener: (event: string, listener: (...args: any[]) => void) => void;
  };
  const isClosed = () =>
    pc.connectionState === "closed" ||
    (pc as RTCPeerConnection & { signalingState: string }).signalingState ===
      "closed";
  const onRequest = async (
    request: {
      method: string;
      data: { candidate: RTCIceCandidateInit | null };
    },
    accept: () => void,
  ) => {
    if (request.method !== label) return;
    const candidate = request.data.candidate;
    if (isClosed()) {
      accept();
      return;
    }
    try {
      await candidates.add(candidate);
    } catch (error) {
      if (!isClosed()) {
        throw error;
      }
    }
    accept();
  };
  eventPeer.on("request", onRequest);

  return () => {
    eventPeer.removeListener("request", onRequest);
    if (!isClosed()) {
      pc.close();
    }
    done();
  };
}

describe("ice/trickle", () => {
  it("answer", async () =>
    new Promise<void>(async (done) => {
      const label = "ice_trickle_answer";

      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const candidates = createNativeCandidateQueue(pc);
      const finish = attachCandidateHandler(label, pc, done);
      pc.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => {
          expect(data).toBe("ping" + "pong");
          finish();
        };
        channel.send("ping");
      };
      pc.ontrack = (ev) => {
        waitVideoPlay(ev.track);
      };
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate ?? null,
          })
          .catch(() => {});
      };

      const offer = await peer.request(label, {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await candidates.flush();
      await pc.setLocalDescription(await pc.createAnswer());

      peer
        .request(label, {
          type: "answer",
          payload: pc.localDescription,
        })
        .catch(() => {});
    }));

  it("offer", async () =>
      new Promise<void>(async (done) => {
        const label = "ice_trickle_offer";

      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const candidates = createNativeCandidateQueue(pc);
      const finish = attachCandidateHandler(label, pc, done);
      const channel = pc.createDataChannel("dc");
      channel.onopen = () => {
        channel.send("ping");
      };
      channel.onmessage = ({ data }) => {
        expect(data).toBe("ping" + "pong");
        finish();
      };
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate ?? null,
          })
          .catch(() => {});
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request(label, {
        type: "init",
        payload: pc.localDescription,
        });
      await pc.setRemoteDescription(answer);
      await candidates.flush();
    }));
});
