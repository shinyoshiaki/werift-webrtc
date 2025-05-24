import { Connection } from "./ice";
import { Candidate } from "./candidate";
import { IceOptions } from "./iceBase";
import { Address } from "./imports/common";
import { randomString } from "./helper";
import { RTCIceParameters } from "../../webrtc/src/transport/ice"; // Adjust path as needed for RTCIceParameters if used for params

const stunServer: Address = ["stun.l.google.com", 19302];

describe("Connection ICE Lite", () => {
  test("constructor initializes correctly for ICE Lite", () => {
    const conn = new Connection(false, { isLite: true, stunServer });
    expect(conn.iceControlling).toBe(false);
    expect(conn.remoteIsLite).toBe(false); // remoteIsLite is set via setRemoteParams
    expect(conn.options.isLite).toBe(true);
    conn.close();
  });

  test("gatherCandidates() for ICE Lite sets state and ends candidates", async () => {
    const conn = new Connection(false, { isLite: true, stunServer });
    await conn.gatherCandidates();
    expect(conn.localCandidates.length).toBe(0);
    expect(conn.localCandidatesEnd).toBe(true);
    expect(conn.state).toBe("completed");
    conn.close();
  });

  test("connect() for ICE Lite sets state to connected", async () => {
    const conn = new Connection(false, { isLite: true, stunServer });
    // For Lite, setRemoteParams is needed before connect can resolve to connected
    conn.setRemoteParams({
      iceLite: false, // The controlling side is not lite
      usernameFragment: randomString(4),
      password: randomString(22),
    });
    await conn.connect(); // This should immediately resolve for a Lite connection
    expect(conn.state).toBe("connected");
    conn.close();
  });

  describe("ICE Lite (server) vs Full ICE (client) end-to-end", () => {
    let serverConn: Connection; // ICE Lite
    let clientConn: Connection; // Full ICE

    beforeEach(() => {
      serverConn = new Connection(false, {
        isLite: true,
        stunServer,
        useIpv4: true,
        useIpv6: false,
      });
      clientConn = new Connection(true, { // iceControlling = true
        isLite: false,
        stunServer,
        useIpv4: true,
        useIpv6: false,
      });
    });

    afterEach(async () => {
      await serverConn.close();
      await clientConn.close();
    });

    test("should establish a connection", (done) => {
      let clientDone = false;
      let serverDone = false;

      const checkDone = () => {
        if (clientDone && serverDone) {
          expect(clientConn.state).toBe("connected");
          expect(serverConn.state).toBe("connected");
          // On the lite (server) side, a nominated pair should be set by the controlling client
          expect(serverConn.nominated).toBeDefined();
          expect(serverConn.nominated?.state).toBe("succeeded"); 
          done();
        }
      };

      clientConn.stateChanged.subscribe((state) => {
        if (state === "connected") clientDone = true;
        if (state === "connected" || state === "failed" || state === "closed") {
          checkDone();
        }
      });
      serverConn.stateChanged.subscribe((state) => {
        if (state === "connected") serverDone = true;
        if (state === "connected" || state === "failed" || state === "closed") {
          checkDone();
        }
      });
      
      clientConn.onIceCandidate.subscribe(async (candidate) => {
        if (candidate) {
          // Simulate signaling: send candidate to server
          await serverConn.addRemoteCandidate(candidate);
        } else {
          // End of candidates from client
          await serverConn.addRemoteCandidate(undefined);
        }
      });

      (async () => {
        // 1. Exchange parameters
        serverConn.setRemoteParams({
          iceLite: false, // Client is not Lite
          usernameFragment: clientConn.localUsername,
          password: clientConn.localPassword,
        });
        clientConn.setRemoteParams({
          iceLite: true, // Server is Lite
          usernameFragment: serverConn.localUsername,
          password: serverConn.localPassword,
        });

        // 2. Server (Lite) "gathers" (sets localCandidatesEnd)
        await serverConn.gatherCandidates();

        // 3. Client (Full) gathers candidates (onIceCandidate will send them to server)
        await clientConn.gatherCandidates();
        
        // 4. Client initiates connection. Server should respond to checks.
        // Lite server connect() resolves quickly. Full client connect() does the work.
        await serverConn.connect(); // Lite side is passive
        await clientConn.connect(); // Full side is active

      })().catch(done); // Catch any async errors from setup
    }, 15000); // Increased timeout for ICE process
  });
});
