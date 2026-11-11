import { peer, sleep, waitVideoPlay } from "../fixture";
import { createNativeCandidateQueue } from "../nativeCandidateQueue";

const label = "bundle_tag_only_candidates";

/** The `a=candidate` / `a=end-of-candidates` lines of every m-section by MID. */
function candidateLines(sdp: string) {
  return Object.fromEntries(
    sdp
      .split(/(?=^m=)/m)
      .slice(1)
      .map((section) => [
        section.match(/^a=mid:(\S+)/m)?.[1],
        {
          candidates: (section.match(/^a=candidate:/gm) ?? []).length,
          end: /^a=end-of-candidates/m.test(section),
          ufrag: /^a=ice-ufrag:/m.test(section),
          fingerprint: /^a=fingerprint:/m.test(section),
        },
      ]),
  );
}

/** The non-tag m-lines of the BUNDLE group carry no candidates, the tag keeps them. */
function expectTagOnly(sdp: string) {
  const [tag, ...members] = sdp
    .match(/^a=group:BUNDLE ([^\r\n]+)/m)![1]
    .trim()
    .split(" ");
  const lines = candidateLines(sdp);
  expect(lines[tag].candidates).toBeGreaterThan(0);
  expect(members.length).toBeGreaterThan(0);
  for (const mid of members) {
    expect(lines[mid]).toEqual({
      candidates: 0,
      end: false,
      ufrag: true,
      fingerprint: true,
    });
  }
}

describe("bundle_tag_only_candidates", () => {
  it(label, async () => {
    if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
    await sleep(100);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const candidates = createNativeCandidateQueue(pc);
    peer.on("notification", (e) => {
      if (e.method === "candidate") {
        if (pc.signalingState === "closed") return;
        void candidates.add(e.data?.candidate ?? null);
      }
    });
    pc.onicecandidate = ({ candidate }) => {
      peer
        .request(label, { type: "candidate", payload: candidate ?? null })
        .catch(() => {});
    };
    const channel = new Promise<RTCDataChannel>((resolve) => {
      pc.ondatachannel = ({ channel }) => {
        if (channel.readyState === "open") resolve(channel);
        else channel.onopen = () => resolve(channel);
      };
    });
    const pingPong = async (text: string) => {
      const dc = await channel;
      const pong = new Promise<void>((resolve) => {
        dc.onmessage = (e) => {
          if (e.data === `pong-${text}`) resolve();
        };
      });
      dc.send(`ping-${text}`);
      await pong;
    };
    const [track] = (
      await navigator.mediaDevices.getUserMedia({ video: true })
    ).getTracks();

    // Arrange: werift (tagOnly) の初回 offer に答えて video と DataChannel を接続する。
    const offer = await peer.request(label, { type: "init" });
    await pc.setRemoteDescription(offer);
    await candidates.flush();
    pc.getTransceivers()[0].direction = "sendrecv";
    await pc.getTransceivers()[0].sender.replaceTrack(track);
    await pc.setLocalDescription(await pc.createAnswer());
    await peer.request(label, { type: "answer", payload: pc.localDescription });
    await waitVideoPlay(pc.getTransceivers()[0].receiver.track);
    await pingPong("initial");

    // Act: werift が ICE restart なしで video を 1 本ずつ足して 2 回再 offer する。
    for (let i = 0; i < 2; i++) {
      const reoffer = await peer.request(label, { type: "reoffer" });
      // Assert: 再 offer の非tag m-line は候補と eoc を持たない。
      expectTagOnly(reoffer.sdp);
      await pc.setRemoteDescription(reoffer);
      const added = pc.getTransceivers().at(-1)!;
      added.direction = "sendrecv";
      await added.sender.replaceTrack(track);
      await pc.setLocalDescription(await pc.createAnswer());
      await peer.request(label, {
        type: "answer",
        payload: pc.localDescription,
      });
      // Assert: 追加した m-line で映像が往復し、DataChannel も届く。
      await waitVideoPlay(added.receiver.track);
      await pingPong(`reoffer-${i}`);
    }

    // Act: ブラウザが video を足して再 offer し、werift が answer を返す。
    const browserAdded = pc.addTransceiver(track, { direction: "sendrecv" });
    await pc.setLocalDescription(await pc.createOffer());
    const answer = await peer.request(label, {
      type: "offer",
      payload: pc.localDescription,
    });
    // Assert: werift の answer も非tag m-line に候補を載せない。
    expectTagOnly(answer.sdp);
    await pc.setRemoteDescription(answer);
    await candidates.flush();
    await waitVideoPlay(browserAdded.receiver.track);
    await pingPong("browser-reoffer");
    expect(pc.connectionState).toBe("connected");

    await peer.request(label, { type: "done" });
    pc.close();
  }, 60_000);
});
