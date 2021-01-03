import { Connection } from "../src";
import readline from "readline";
import { Candidate } from "../src/candidate";

const reader = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

(async () => {
  const connection = new Connection(true, {
    stunServer: ["stun.l.google.com", 19302],
    log: false,
  });
  await connection.gatherCandidates();

  const candidates = connection.localCandidates.map((v) => v.toSdp());
  const sdp = {
    candidates,
    name: connection.localUserName,
    pass: connection.localPassword,
  };

  console.log(JSON.stringify(sdp));

  reader.prompt();

  // send offer
  await new Promise<void>((r) => {
    const listen = async (line: string) => {
      const { candidates, name, pass } = JSON.parse(line);
      connection.remoteCandidates = candidates.map((v: any) =>
        Candidate.fromSdp(v)
      );
      connection.remoteUsername = name;
      connection.remotePassword = pass;
      reader.prompt();
      reader.removeListener("line", listen);
      r();
    };
    reader.on("line", listen);
  });

  // connect
  await new Promise<void>((r) => {
    const listen = async (line: string) => {
      if (line.length === 0) {
        await connection.connect();
        await connection.onData.asPromise();
        await connection.send(Buffer.from("offer"));
        reader.prompt();
        reader.removeListener("line", listen);
        r();
      }
    };
    reader.on("line", listen);
  });

  connection.onData.subscribe((v) => {
    console.log(v.toString());
  });

  reader.on("line", async (line) => {
    await connection.send(Buffer.from(line));
    reader.prompt();
  });
})();
