import { Connection, Candidate } from "../../../ice/src";
import readline from "readline";
import { DtlsClient } from "../../src";
import { createIceTransport } from "../transport/ice";

const reader = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

(async () => {
  const connection = new Connection(false, {
    stunServer: ["stun.l.google.com", 19302],
    log: false,
  });

  // set offer; send answer
  await new Promise<void>((r) => {
    const listen = async (line: string) => {
      console.log("set offer");
      const { candidates, name, pass } = JSON.parse(line);
      connection.remoteCandidates = candidates.map((v: any) =>
        Candidate.fromSdp(v)
      );
      connection.remoteUsername = name;
      connection.remotePassword = pass;
      reader.prompt();

      await connection.gatherCandidates();

      const sdp = {
        candidates: connection.localCandidates.map((v) => v.toSdp()),
        name: connection.localUserName,
        pass: connection.localPassword,
      };

      console.log(JSON.stringify(sdp));
      reader.prompt();
      reader.removeListener("line", listen);
      r();
      console.log("answer start connect first after offer set answer");
    };

    reader.on("line", listen);
  });

  // connect
  await new Promise<void>((r) => {
    const listen = async () => {
      console.log("start connect");
      reader.prompt();
      reader.removeListener("line", listen);

      await connection.connect();
      await connection.send(Buffer.from("ice answer"));

      // todo fix
      // console.log((await connection.recv()).toString());

      await new Promise((r) => setTimeout(r, 1000));
      console.log("client start");

      const dtls = new DtlsClient({
        transport: createIceTransport(connection),
      });
      dtls.onConnect = async () => {
        console.log("dtls connected");
        await new Promise((r) => setTimeout(r, 1000));
        dtls.send(Buffer.from("dtls_server"));
        reader.prompt();
        reader.on("line", async (line) => {
          dtls.send(Buffer.from(line));
          reader.prompt();
        });
        r();
      };
      dtls.onData = (v) => {
        console.log(v.toString());
      };
      dtls.connect();
    };
    reader.on("line", listen);
  });
})();
