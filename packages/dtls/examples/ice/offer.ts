import readline from "readline";
import { Connection, Candidate } from "../../../ice/src";
import { DtlsServer } from "../../src";
import { readFileSync } from "fs";
import { createIceTransport } from "../transport/ice";

const reader = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

(async () => {
  const connection = new Connection(true, {
    stunServer: ["stun.l.google.com", 19302],
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
      console.log("set answer");
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

  await new Promise<void>((r) => {
    const listen = async () => {
      console.log("start connect");
      reader.prompt();
      reader.removeListener("line", listen);

      await connection.connect();
      await connection.send(Buffer.from("ice offer"));

      console.log("server start");

      const dtls = new DtlsServer({
        transport: createIceTransport(connection),
        cert: readFileSync("assets/cert.pem").toString(),
        key: readFileSync("assets/key.pem").toString(),
      });
      dtls.onConnect.once(async () => {
        console.log("dtls connected");
        await new Promise((r) => setTimeout(r, 1000));
        dtls.send(Buffer.from("dtls_client"));
        reader.prompt();
        reader.on("line", async (line) => {
          dtls.send(Buffer.from(line));
          reader.prompt();
        });
        r();
      });
      dtls.onData.subscribe((v) => {
        console.log(v.toString());
      });
    };
    reader.on("line", listen);
  });
})();
