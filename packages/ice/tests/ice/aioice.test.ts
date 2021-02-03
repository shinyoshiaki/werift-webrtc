import { PythonShell } from "python-shell";
import { sleep } from "../../src/utils";
import { Connection, Candidate } from "../../src";
import WS from "ws";

// todo fix for gh-actions
xtest(
  "aioice",
  async (done) => {
    const WEBSOCKET_URI = "ws://127.0.0.1:8765";
    const server = PythonShell.run(
      "python/signaling-server.py",
      undefined,
      () => {}
    );

    const connection = new Connection(false, {
      stunServer: ["stun.l.google.com", 19302],
    });
    await connection.gatherCandidates();

    await sleep(2000);

    const ws = new WS(WEBSOCKET_URI);
    await new Promise((r) => ws.once("open", r));

    PythonShell.run("python/offer.py", undefined, () => {});

    const message: string = await new Promise((r) =>
      ws.once("message", (data) => r(data))
    );
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

    connection.connect();

    const [data] = await connection.onData.asPromise();
    expect(data.toString()).toBe("hello");
    await connection.send(Buffer.from("ice tea"));
    await sleep(100);
    await connection.close();
    server.kill();
    done();
  },
  10 * 1000
);
