// https://github.com/dguenther/js-datachannel-benchmarks
/**
 * Compares the time to send a binary message to another peer, then receive
 * a message back.
 */

import { randomBytes } from "crypto";
import Benchmark from "benchmark";
import * as Werift from "../../packages/webrtc/src";

console.log("Setting up...");

const suite = new Benchmark.Suite();

const testData: {
  werift: {
    dc1: Werift.RTCDataChannel;
    dc2: Werift.RTCDataChannel;
    peer1: Werift.RTCPeerConnection;
    peer2: Werift.RTCPeerConnection;
  };
} = {
  werift: {
    peer1: null,
    peer2: null,
    dc1: null,
    dc2: null,
  },
};

const weriftSetup = new Promise<void>((resolve) => {
  testData.werift.peer1 = new Werift.RTCPeerConnection({});
  testData.werift.peer2 = new Werift.RTCPeerConnection({});

  testData.werift.dc1 = testData.werift.peer1.createDataChannel("chat");

  const { peer1, peer2, dc1 } = testData.werift;

  peer1.onicecandidate = (e) => {
    if (e.candidate) {
      peer2.addIceCandidate(e.candidate);
    }
  };
  peer2.onicecandidate = (e) => {
    if (e.candidate) {
      peer1.addIceCandidate(e.candidate);
    }
  };

  dc1.stateChanged.subscribe((state) => {
    if (state === "open") {
      resolve();
    }
  });

  peer2.onDataChannel.subscribe((channel) => {
    testData.werift.dc2 = channel;
  });

  peer1
    .createOffer()
    .then((offer) => peer1.setLocalDescription(offer))
    .then(() => peer2.setRemoteDescription(peer1.localDescription))
    .then(() => peer2.createAnswer())
    .then((answer) => peer2.setLocalDescription(answer))
    .then(() => peer1.setRemoteDescription(peer2.localDescription));
});

async function runTests() {
  await Promise.all([weriftSetup]);
  console.log("Setup complete. Running benchmarks...");

  const message = randomBytes(5000);

  suite
    .add("werift", {
      defer: true,
      fn: function (deferred) {
        const { dc1, dc2 } = testData.werift;

        dc2.message.once((m) => {
          dc2.send(m);
        });

        dc1.message.once((e) => {
          deferred.resolve();
        });

        dc1.send(message);
      },
    })
    .on("cycle", function (event) {
      console.log(String(event.target));
    })
    .on("complete", function () {})
    .run({ async: false });
}

runTests();
