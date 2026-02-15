import { assert } from 'node:test';
import { RTCPeerConnection } from 'werift';

const pcA = new RTCPeerConnection();
const pcB = new RTCPeerConnection();


const dcA = pcA.createDataChannel("test");
const dcBPromise = new Promise((resolve) => {
    pcB.ondatachannel = (event) => {
        console.log("data channel event");
        resolve(event.channel);
    };
});


const offer = await pcA.createOffer();
await pcB.setRemoteDescription(await pcA.setLocalDescription(offer));
console.log("offer set");

const answer = await pcB.createAnswer();
await pcA.setRemoteDescription(await pcB.setLocalDescription(answer));
console.log("answer set");

const dcB = await dcBPromise;
console.log("data channel created");

const message = "Hello, World!";
setImmediate(() => {
    dcA.send(message);
});

const [msg] = await dcB.onMessage.asPromise()
console.log("message received:", msg);

assert.equal(msg, message);

process.exit(0);