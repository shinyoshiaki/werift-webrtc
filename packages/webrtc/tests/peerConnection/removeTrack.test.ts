import { MediaStreamTrack, RTCPeerConnection } from "../../src";

// todo impl perfect
// webrtc/RTCPeerConnection-removeTrack.https.html
describe("peerConnection/removeTrack", () => {
  test("addTransceiver - Calling removeTrack with valid sender should set sender.track to null", () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(track);
    const { sender } = transceiver;

    expect(sender.track).toEqual(track);
    expect(transceiver.direction).toBe("sendrecv");
    expect(transceiver.currentDirection).toBeFalsy();

    pc.removeTrack(sender);
    expect(sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("recvonly");
    pc.close();
  });

  test("addTrack - Calling removeTrack with valid sender should set sender.track to null", () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    expect(sender.track).toEqual(track);

    pc.removeTrack(sender);
    expect(sender.track).toBeFalsy();
  });
});
