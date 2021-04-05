import { MediaStreamTrack, RTCPeerConnection } from "../../src";
import { generateAnswer } from "../fixture";

// webrtc/RTCPeerConnection-removeTrack.https.html
describe("peerConnection/removeTrack", () => {
  test("addTransceiver - Calling removeTrack when connection is closed should throw InvalidStateError", async () => {
    const pc = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(track);
    const { sender } = transceiver;

    await pc.close();
    expect(() => pc.removeTrack(sender)).toThrowError("peer closed");
  });

  test("addTrack - Calling removeTrack when connection is closed should throw InvalidStateError", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    await pc.close();
    expect(() => pc.removeTrack(sender)).toThrowError("peer closed");
  });

  test("addTransceiver - Calling removeTrack on different connection that is closed should throw InvalidStateError", async () => {
    const pc = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(track);
    const { sender } = transceiver;

    const pc2 = new RTCPeerConnection();
    pc2.close();
    expect(() => pc2.removeTrack(sender)).toThrowError("peer closed");
  });

  test("addTrack - Calling removeTrack on different connection that is closed should throw InvalidStateError", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    const pc2 = new RTCPeerConnection();
    await pc2.close();
    expect(() => pc2.removeTrack(sender)).toThrowError("peer closed");

    await pc.close();
  });

  test("addTransceiver - Calling removeTrack on different connection should throw InvalidAccessError", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(track);
    const { sender } = transceiver;

    const pc2 = new RTCPeerConnection();
    expect(() => pc2.removeTrack(sender)).toThrowError("unExist");

    await pc.close();
    await pc2.close();
  });

  test("addTrack - Calling removeTrack on different connection should throw InvalidAccessError", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    const pc2 = new RTCPeerConnection();
    expect(() => pc2.removeTrack(sender)).toThrowError("unExist");

    await pc.close();
    await pc2.close();
  });

  test("addTransceiver - Calling removeTrack with valid sender should set sender.track to null", async () => {
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
    await pc.close();
  });

  test("addTrack - Calling removeTrack with valid sender should set sender.track to null", () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    expect(sender.track).toEqual(track);

    pc.removeTrack(sender);
    expect(sender.track).toBeFalsy();
  });

  test("Calling removeTrack with currentDirection sendrecv should set direction to recvonly", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = caller.addTransceiver(track);
    const { sender } = transceiver;

    expect(sender.track).toEqual(track);
    expect(transceiver.direction).toBe("sendrecv");
    expect(transceiver.currentDirection).toBeFalsy();

    const offer = await caller.createOffer();
    await caller.setLocalDescription(offer);
    await callee.setRemoteDescription(offer);
    callee.addTrack(track);
    const answer = await callee.createAnswer();
    await callee.setLocalDescription(answer);
    await caller.setRemoteDescription(answer);
    expect(transceiver.currentDirection).toBe("sendrecv");

    caller.removeTrack(sender);
    expect(sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("recvonly");
    expect(transceiver.currentDirection).toBe("sendrecv");

    await caller.close();
    await callee.close();
  });

  test("Calling removeTrack with currentDirection sendonly should set direction to inactive", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
    const { sender } = transceiver;

    expect(sender.track).toEqual(track);
    expect(transceiver.direction).toBe("sendonly");
    expect(transceiver.currentDirection).toBeFalsy();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await generateAnswer(offer);
    await pc.setRemoteDescription(answer);
    expect(transceiver.currentDirection).toBe("sendonly");

    pc.removeTrack(sender);
    expect(sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("inactive");
    expect(transceiver.currentDirection).toBe("sendonly");

    await pc.close();
  });

  test("Calling removeTrack with currentDirection recvonly should not change direction", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = caller.addTransceiver(track, { direction: "recvonly" });
    const { sender } = transceiver;

    expect(sender.track).toEqual(track);
    expect(transceiver.direction).toBe("recvonly");
    expect(transceiver.currentDirection).toBeFalsy();

    const offer = await caller.createOffer();
    await caller.setLocalDescription(offer);
    await callee.setRemoteDescription(offer);
    callee.addTrack(track);
    const answer = await callee.createAnswer();
    await callee.setLocalDescription(answer);
    await caller.setRemoteDescription(answer);
    expect(transceiver.currentDirection).toBe("recvonly");

    caller.removeTrack(sender);
    expect(sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("recvonly");
    expect(transceiver.currentDirection).toBe("recvonly");

    await caller.close();
    await callee.close();
  });

  test("Calling removeTrack with currentDirection inactive should not change direction", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(track, { direction: "inactive" });
    const { sender } = transceiver;

    expect(sender.track).toEqual(track);
    expect(transceiver.direction).toBe("inactive");
    expect(transceiver.currentDirection).toBeFalsy();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await generateAnswer(offer);
    await pc.setRemoteDescription(answer);
    expect(transceiver.currentDirection).toBe("inactive");

    pc.removeTrack(sender);
    expect(sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("inactive");
    expect(transceiver.currentDirection).toBe("inactive");

    await pc.close();
  });

  // todo fix
  xtest("Calling removeTrack on a stopped transceiver should be a no-op", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    pc.getTransceivers()[0].stop();
    pc.removeTrack(sender);
    expect(sender.track).toEqual(track);
  });

  test("Calling removeTrack on a null track should have no effect", async () => {
    const pc = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    await sender.replaceTrack(null);
    pc.removeTrack(sender);
    expect(sender.track).toBeFalsy();

    await pc.close();
  });
});
