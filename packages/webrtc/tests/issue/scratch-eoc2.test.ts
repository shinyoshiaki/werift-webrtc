import { MediaStreamTrack, RTCPeerConnection } from "../../src";
import {
  forwardIceCandidates,
  negotiateOfferAnswer,
  parseSdp,
} from "./705.helpers";

describe("scratch eoc2", () => {
  test("trace", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });
    const stop = forwardIceCandidates(offerer, answerer);
    const conn = () =>
      (answerer.getTransceivers()[0]?.dtlsTransport?.iceTransport as any)
        ?.connection;
    await negotiateOfferAnswer(offerer, answerer);
    console.log("after negotiate End:", conn()?.remoteCandidatesEnd);
    const reOffer = await offerer.createOffer();
    await offerer.setLocalDescription(reOffer);
    const mid = parseSdp(reOffer.sdp).media[0]?.rtp.muxId;
    console.log(
      "reOffer has EOC:",
      /end-of-candidates/.test(reOffer.sdp ?? ""),
    );
    const craftedSdp = reOffer.sdp
      ?.replace(/a=ice-ufrag:[^\r\n]+/, "a=ice-ufrag:rstxxx")
      .replace(
        "\r\nm=",
        "\r\na=candidate:1 1 udp 2113929471 192.0.2.1 10100 typ host\r\na=end-of-candidates\r\nm=",
      );
    console.log(
      "crafted complete:",
      parseSdp(craftedSdp).media[0]?.iceCandidatesComplete,
    );
    await answerer.setRemoteDescription({ ...reOffer, sdp: craftedSdp });
    console.log("after SRD End:", conn()?.remoteCandidatesEnd);
    await answerer.setRemoteDescription({ type: "rollback" });
    console.log("after rollback End:", conn()?.remoteCandidatesEnd);
    stop();
    await Promise.all([offerer.close(), answerer.close()]);
  }, 30000);
});
