const { equal } = require("node:assert");
const { RTCPeerConnection } = require("werift-dev");
const { SCTP } = require("werift-sctp");

async function main() {
    // Arrange: CJS の require でローカル build の werift と SCTP を読み込む
    equal(typeof RTCPeerConnection, "function");
    equal(typeof SCTP, "function");

    const pcA = new RTCPeerConnection();
    const pcB = new RTCPeerConnection();

    const dcA = pcA.createDataChannel("test");
    const dcBPromise = new Promise((resolve) => {
        pcB.ondatachannel = (event) => {
            resolve(event.channel);
        };
    });

    // Act: offer / answer を交換して DataChannel を開く
    const offer = await pcA.createOffer();
    await pcB.setRemoteDescription(await pcA.setLocalDescription(offer));

    const answer = await pcB.createAnswer();
    await pcA.setRemoteDescription(await pcB.setLocalDescription(answer));

    const dcB = await dcBPromise;

    const message = "Hello, World!";
    setImmediate(() => {
        dcA.send(message);
    });

    const [msg] = await dcB.onMessage.asPromise();

    // Assert: CJS 経由でも DataChannel のメッセージが届く
    equal(msg, message);

    pcA.close();
    pcB.close();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
