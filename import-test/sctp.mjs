import { createSocket } from "dgram";
import { SCTP, WEBRTC_PPID, createUdpTransport } from "werift-sctp";

const port = 5555;

const socket = createSocket("udp4");
socket.bind(port);

const server = SCTP.server(createUdpTransport(socket));
server.onReceive.subscribe((streamId, ppId, data) => {
    console.log(data.toString());
    server.send(0, WEBRTC_PPID.STRING, Buffer.from("pong"));
});

const client = SCTP.client(
    createUdpTransport(createSocket("udp4"), {
        port,
        address: "127.0.0.1",
    })
);
const promise = new Promise(r => {
    client.onReceive.subscribe((streamId, ppId, data) => {
        console.log(data.toString());
        r();
    });
})

await Promise.all([client.start(5000), server.start(5000)]);
await Promise.all([
    client.stateChanged.connected.asPromise(),
    server.stateChanged.connected.asPromise(),
]);

client.send(0, WEBRTC_PPID.STRING, Buffer.from("ping"));

await promise;

await server.stop();
await client.stop();
server.transport.close();
client.transport.close();

console.log("sctp done");