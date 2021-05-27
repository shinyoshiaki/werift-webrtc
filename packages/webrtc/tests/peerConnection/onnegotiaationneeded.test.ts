// webrtc/RTCPeerConnection-onnegotiationneeded.html

import { RTCPeerConnection } from "../../src";
import { generateAnswer, generateOffer } from "../fixture";
import { generateAudioReceiveOnlyOffer } from "../utils";

describe("onnegotiationneeded", () => {
  test("Creating first data channel should fire negotiationneeded event", async () => {
    const pc = new RTCPeerConnection();

    const negotiated = awaitNegotiation(pc);

    pc.createDataChannel("test");
    await negotiated;
    await pc.close();
  });

  test("calling createDataChannel twice should fire negotiationneeded event once", async () =>
    new Promise<void>(async (done) => {
      const pc = new RTCPeerConnection();
      const negotiated = awaitNegotiation(pc);

      pc.createDataChannel("foo");
      negotiated.then(({ nextPromise }) => {
        pc.createDataChannel("bar");
        nextPromise.then(() => {
          throw new Error();
        });
        setTimeout(() => {
          pc.close();
          done();
        }, 100);
      });
    }));

  test("addTransceiver() should fire negotiationneeded event", async () => {
    const pc = new RTCPeerConnection();
    const negotiated = awaitNegotiation(pc);

    pc.addTransceiver("audio");
    await negotiated;
    await pc.close();
  });

  test("Calling addTransceiver() twice should fire negotiationneeded event once", async () =>
    new Promise<void>(async (done) => {
      const pc = new RTCPeerConnection();
      const negotiated = awaitNegotiation(pc);

      pc.addTransceiver("audio");
      negotiated.then(({ nextPromise }) => {
        pc.addTransceiver("video");
        nextPromise.then(() => {
          throw new Error();
        });
        setTimeout(() => {
          pc.close();
          done();
        }, 100);
      });
    }));

  test("Calling both addTransceiver() and createDataChannel() should fire negotiationneeded event once", async () =>
    new Promise<void>(async (done) => {
      const pc = new RTCPeerConnection();
      const negotiated = awaitNegotiation(pc);

      pc.createDataChannel("test");
      negotiated.then(({ nextPromise }) => {
        pc.addTransceiver("video");
        nextPromise.then(() => {
          throw new Error();
        });
        setTimeout(() => {
          pc.close();
          done();
        }, 100);
      });
    }));

  test("negotiationneeded event should not fire if signaling state is not stable", async () =>
    new Promise<void>(async (done) => {
      const pc = new RTCPeerConnection();
      let negotiated;

      generateAudioReceiveOnlyOffer(pc)
        .then((offer) => {
          pc.setLocalDescription(offer);
          negotiated = awaitNegotiation(pc);
        })
        .then(() => {
          return negotiated;
        })
        .then(({ nextPromise }) => {
          expect(pc.signalingState).toBe("have-local-offer");
          pc.createDataChannel("test");
          nextPromise.then(() => {
            throw new Error();
          });
          setTimeout(() => {
            pc.close();
            done();
          }, 100);
        });
    }));

  test("negotiationneeded event should fire only after signaling state goes back to stable after setRemoteDescription", async () => {
    const pc = new RTCPeerConnection();

    pc.addTransceiver("audio");
    await new Promise((resolve) => (pc.onnegotiationneeded = resolve));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let fired = false;
    pc.onnegotiationneeded = (e) => (fired = true);
    pc.createDataChannel("test");
    await pc.setRemoteDescription(await generateAnswer(offer));
    expect(fired).toBe(false);

    await new Promise((resolve) => (pc.onnegotiationneeded = resolve));
    await pc.close();
  });

  test("negotiationneeded event should fire only after signaling state goes back to stable after setLocalDescription", async () => {
    const pc = new RTCPeerConnection();

    pc.addTransceiver("audio");
    await new Promise((resolve) => (pc.onnegotiationneeded = resolve));

    let fired = false;
    pc.onnegotiationneeded = (e) => (fired = true);
    await pc.setRemoteDescription(await generateOffer());
    pc.createDataChannel("test");
    await pc.setLocalDescription(await pc.createAnswer());
    expect(fired).toBe(false);

    await new Promise((resolve) => (pc.onnegotiationneeded = resolve));
    await pc.close();
  });

  test("negotiationneeded event should fire only after signalingstatechange event fires from setRemoteDescription", async () => {
    const pc = new RTCPeerConnection();

    pc.addTransceiver("audio");
    await new Promise((resolve) => (pc.onnegotiationneeded = resolve));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let fired = false;
    pc.onnegotiationneeded = (e) => (fired = true);
    pc.createDataChannel("test");
    const p = pc.setRemoteDescription(await generateAnswer(offer));
    await new Promise((resolve) => (pc.onsignalingstatechange = resolve));
    expect(fired).toBe(false);
    await new Promise((resolve) => (pc.onnegotiationneeded = resolve));
    await p;
    await pc.close();
  });
});

function awaitNegotiation(pc: RTCPeerConnection) {
  if (pc.onnegotiationneeded) {
    throw new Error(
      "connection is already attached with onnegotiationneeded event handler"
    );
  }

  function waitNextNegotiation() {
    return new Promise<any>((resolve) => {
      pc.onnegotiationneeded = (event) => {
        const nextPromise = waitNextNegotiation();
        resolve({ nextPromise, event });
      };
    });
  }

  return waitNextNegotiation();
}
