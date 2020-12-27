import WS from "ws";
import { Connection, Candidate } from "../src";

const WEBSOCKET_URI = "ws://127.0.0.1:8765";

// answer first
(async () => {
  const connection = new Connection(false, {
    stunServer: ["stun.l.google.com", 19302],
  });
  await connection.gatherCandidates();

  const ws = new WS(WEBSOCKET_URI);
  await new Promise((r) => ws.once("open", r));

  const message: string = await new Promise((r) =>
    ws.once("message", (data) => r(data))
  );
  console.log("received offer", message);
  const { candidates, username, password } = JSON.parse(message);
  connection.remoteCandidates = candidates.map((v: string) =>
    Candidate.fromSdp(v)
  );
  connection.remoteUsername = username;
  connection.remotePassword = password;

  ws.send(
    JSON.stringify({
      candidates: connection.localCandidates.map((v) => v.toSdp()),
      password: connection.localPassword,
      username: connection.localUserName,
    })
  );

  await new Promise((r) => {
    ws.once("close", r);
    ws.close();
  });

  await connection.connect();
  console.log("connected");

  const [data, component] = await connection.recvFrom();
  console.log(`echoing ${data.toString()} on component ${component}`);
  await connection.sendTo(Buffer.from("ice tea"), component);

  await new Promise((r) => setTimeout(r, 5000));
  await connection.close();
  console.log("closed");
  process.exit();
})();
