import { MediaStreamTrack, RTCPeerConnection } from "../../src";
import { RTCRtpSender } from "../../src/media/rtpSender";

jest.setTimeout(10_000);

// https://github.com/web-platform-tests/wpt/blob/master/webrtc/RTCPeerConnection-addTrack.https.html

describe("peerConnection/addTrack", () => {
  it("addTrack when pc is closed should throw InvalidStateError", async () => {
    const pc = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });
    await pc.close();

    expect(() => pc.addTrack(track)).toThrowError("is closed");
  });

  it("addTrack with single track argument and no stream should succeed", async () => {
    const pc = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });

    const sender = pc.addTrack(track);

    expect(sender).toBeInstanceOf(RTCRtpSender);
    expect(sender.track).toEqual(track);

    const transceivers = pc.getTransceivers();
    expect(transceivers.length).toBe(1);

    const [transceiver] = transceivers;
    expect(transceiver.sender).toEqual(sender);

    expect([sender]).toEqual(pc.getSenders());

    expect(transceiver.direction).toBe("sendrecv");

    // const { receiver } = transceiver;
    // assert_equals(receiver.track.kind, 'audio');
    // assert_array_equals([transceiver.receiver], pc.getReceivers(),
    //   'Expect only one receiver associated with transceiver added');

    await pc.close();
  });

  it("Adding the same track multiple times should throw InvalidAccessError", async () => {
    const pc = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });

    pc.addTrack(track);
    expect(() => pc.addTrack(track)).toThrowError("track exist");

    await pc.close();
  });

  xit("addTrack with existing sender with null track, same kind, and recvonly direction should reuse sender", async () => {
    const pc = new RTCPeerConnection();
    const transceiver = pc.addTransceiver("audio", { direction: "recvonly" });
    expect(transceiver.sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("recvonly");

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    expect(sender).toEqual(transceiver.sender);
    expect(sender.track).toEqual(track);
    expect(transceiver.direction).toBe("sendrecv");
    expect([sender]).toEqual(pc.getSenders());

    await pc.close();
  });

  it("addTrack with existing sender that has not been used to send should reuse the sender", async () => {
    const pc = new RTCPeerConnection();

    const transceiver = pc.addTransceiver("audio");
    expect(transceiver.sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("sendrecv");

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    expect(sender.track).toEqual(track);
    expect(sender).toEqual(transceiver.sender);

    await pc.close();
  });

  xit("addTrack with existing sender that has been used to send should create new sender", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    const track = new MediaStreamTrack({ kind: "audio" });
    const transceiver = caller.addTransceiver(track);
    {
      const offer = await caller.createOffer();
      await caller.setLocalDescription(offer);
      await callee.setRemoteDescription(offer);
      const answer = await callee.createAnswer();
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(answer);
    }
    expect(transceiver.currentDirection).toBe("sendonly");

    caller.removeTrack(transceiver.sender);
    {
      const offer = await caller.createOffer();
      await caller.setLocalDescription(offer);
      await callee.setRemoteDescription(offer);
      const answer = await callee.createAnswer();
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(answer);
    }
    expect(transceiver.direction).toBe("recvonly");
    expect(transceiver.currentDirection).toBe("inactive");

    // |transceiver.sender| is currently not used for sending, but it should not be reused because it has been used for sending before.
    const sender = caller.addTrack(track);
    expect(sender).toBeTruthy();
    expect(sender).not.toEqual(transceiver.sender);

    await Promise.all([callee.close(), caller.close()]);
  });

  it("addTrack with existing sender with null track, different kind, and recvonly direction should create new sender", async () => {
    const pc = new RTCPeerConnection();

    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
    expect(transceiver.sender.track).toBeFalsy();
    expect(transceiver.direction).toBe("recvonly");

    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    expect(sender.track).toEqual(track);
    expect(sender).not.toEqual(transceiver.sender);

    const senders = pc.getSenders();
    expect(senders.length).toBe(2);

    expect(senders.includes(sender)).toBeTruthy();
    expect(senders.includes(transceiver.sender)).toBeTruthy();

    await pc.close();
  });
});
