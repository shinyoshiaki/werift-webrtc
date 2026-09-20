import { RTCPeerConnection } from "../../src";
import { negotiateOfferAnswer, parseSdp } from "./705.helpers";

describe("scratch stagedbg", () => {
  test("trace", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    await negotiateOfferAnswer(offerer, answerer);
    const t = answerer.getTransceivers()[0];
    const ice = t.dtlsTransport.iceTransport as any;
    const stagedOf = () => (answerer as any).stagedIceParams as Map<any, any>;
    console.log(
      "base:",
      ice.connection.remoteUsername,
      JSON.stringify(ice.connection.remoteCandidates.map((c: any) => c.host)),
      ice.connection.remoteCandidatesEnd,
    );
    const reOffer = await offerer.createOffer();
    await offerer.setLocalDescription(reOffer);
    const craftedSdp =
      reOffer.sdp
        ?.replace(/a=ice-ufrag:[^\r\n]+/, "a=ice-ufrag:commit11")
        .replace(/a=ice-pwd:[^\r\n]+/, "a=ice-pwd:0123456789abcdefghijuy")
        .replace(
          "\r\nm=",
          "\r\na=candidate:1 1 udp 2113929471 192.0.2.1 10100 typ host\r\na=end-of-candidates\r\nm=",
        ) ?? reOffer.sdp;
    const parsed = parseSdp(craftedSdp);
    console.log(
      "parsed cands:",
      parsed.media[0]?.iceCandidates.length,
      "complete:",
      parsed.media[0]?.iceCandidatesComplete,
      "ufrag:",
      parsed.media[0]?.iceParams?.usernameFragment,
    );
    await answerer.setRemoteDescription({ ...reOffer, sdp: craftedSdp });
    console.log(
      "staged size:",
      stagedOf().size,
      "cands:",
      [...stagedOf().values()].map((s: any) => s.candidates.length),
      "eoc:",
      [...stagedOf().values()].map((s: any) => s.endOfCandidates),
    );
    console.log(
      "pre-commit:",
      ice.connection.remoteUsername,
      JSON.stringify(ice.connection.remoteCandidates.map((c: any) => c.host)),
      ice.connection.remoteCandidatesEnd,
    );
    await answerer.setLocalDescription(await answerer.createAnswer());
    console.log(
      "post-commit:",
      ice.connection.remoteUsername,
      JSON.stringify(ice.connection.remoteCandidates.map((c: any) => c.host)),
      ice.connection.remoteCandidatesEnd,
    );
    await Promise.all([offerer.close(), answerer.close()]);
  }, 30000);
});
