import { peer, sleep, waitVideoPlay } from "../fixture";

function attachCandidateHandler(
  label: string,
  pc: RTCPeerConnection,
  done: () => void,
) {
  const eventPeer = peer as typeof peer & {
    removeListener: (event: string, listener: (...args: any[]) => void) => void;
  };
  const isClosed = () =>
    pc.connectionState === "closed" ||
    (pc as RTCPeerConnection & { signalingState: string }).signalingState ===
      "closed";
  const onRequest = async (
    request: { method: string; data: RTCIceCandidateInit },
    accept: () => void,
  ) => {
    if (request.method !== label) return;
    const candidate = request.data;
    if (isClosed()) {
      accept();
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      if (!isClosed()) {
        throw error;
      }
    }
    accept();
  };
  peer.on("request", onRequest);

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
        if (candidate) {
          peer
            .request(label, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        }
      };

      const offer = await peer.request(label, {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
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
            payload: candidate,
          })
          .catch(() => {});
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request(label, {
        type: "init",
        payload: pc.localDescription,
      });
      await pc.setRemoteDescription(answer);
    }));
});
