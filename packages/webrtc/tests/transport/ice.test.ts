import inRange from "lodash/inRange";

import { RTCIceGatherer, RTCIceTransport } from "../../src";

import { RTCIceParameters } from "../../src/transport/ice";
import { SessionDescription } from "../../src/sdp";

describe("iceTransport", () => {
  test("test_connect", async () => {
    const gatherer1 = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      useIpv4: true,
      useIpv6: false,
    });
    const transport1 = new RTCIceTransport(gatherer1);
    transport1.connection.iceControlling = true;

    const gatherer2 = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      useIpv4: true,
      useIpv6: false,
    });
    const transport2 = new RTCIceTransport(gatherer2);
    transport2.connection.iceControlling = false;

    expect(transport1.state).toBe("new");
    expect(transport2.state).toBe("new");

    await Promise.all([gatherer1.gather(), gatherer2.gather()]);

    expect(transport1.state).toBe("completed");
    expect(transport2.state).toBe("completed");

    gatherer2.localCandidates.forEach(transport1.addRemoteCandidate);
    gatherer1.localCandidates.forEach(transport2.addRemoteCandidate);

    transport1.setRemoteParams(gatherer2.localParameters);
    transport2.setRemoteParams(gatherer1.localParameters);
    await Promise.all([transport1.start(), transport2.start()]);
    expect(transport1.state).toBe("connected");
    expect(transport2.state).toBe("connected");

    await Promise.all([transport1.stop(), transport2.stop()]);
    expect(transport1.state).toBe("closed");
    expect(transport2.state).toBe("closed");
  }, 15000);

  describe("ICE Lite", () => {
    test("constructor configures underlying Connection and localParameters for ICE Lite", () => {
      const liteGatherer = new RTCIceGatherer({ isLite: true });
      const liteTransport = new RTCIceTransport(liteGatherer); // RTCIceTransport itself doesn't take isLite directly in this setup

      expect(liteTransport.connection.options.isLite).toBe(true);
      const localParams = liteTransport.localParameters;
      expect(localParams).toBeInstanceOf(RTCIceParameters);
      expect(localParams.iceLite).toBe(true);

      liteTransport.stop();
    });

    test("SDP generation includes a=ice-lite for ICE Lite mode", async () => {
      const liteGatherer = new RTCIceGatherer({ isLite: true });
      await liteGatherer.gather(); // Gather parameters
      const localParams = liteGatherer.localParameters;

      const sdp = new SessionDescription("offer");
      const media = new MediaDescription("application", 9, "DTLS/SCTP", ["webrtc-datachannel"]);
      media.iceParams = localParams; // Assign RTCIceParameters from the gatherer
      media.dtlsParams = new RTCDtlsParameters([], "actpass"); // Dummy DTLS params

      sdp.media.push(media);
      
      expect(media.toString()).toContain("a=ice-lite");

      liteGatherer.connection.close();
    });

    test("SDP generation does NOT include a=ice-lite for full ICE mode", async () => {
      const fullGatherer = new RTCIceGatherer({ isLite: false });
      await fullGatherer.gather();
      const localParams = fullGatherer.localParameters;

      const sdp = new SessionDescription("offer");
      const media = new MediaDescription("application", 9, "DTLS/SCTP", ["webrtc-datachannel"]);
      media.iceParams = localParams;
      media.dtlsParams = new RTCDtlsParameters([], "actpass");

      sdp.media.push(media);

      expect(media.toString()).not.toContain("a=ice-lite");
      
      fullGatherer.connection.close();
    });
    
    test("end-to-end ICE Lite (server) vs Full ICE (client)", async () => {
      const serverGatherer = new RTCIceGatherer({ 
        isLite: true, 
        stunServer: ["stun.l.google.com", 19302],
        useIpv4: true,
        useIpv6: false,
      });
      const serverTransport = new RTCIceTransport(serverGatherer);
      // serverTransport.connection.iceControlling = false; // Already false by default and due to isLite on Connection

      const clientGatherer = new RTCIceGatherer({ 
        isLite: false, 
        stunServer: ["stun.l.google.com", 19302],
        useIpv4: true,
        useIpv6: false,
      });
      const clientTransport = new RTCIceTransport(clientGatherer);
      clientTransport.connection.iceControlling = true;


      let clientConnected = false;
      let serverConnected = false;
      const onClientConnected = new Promise(r => clientTransport.onStateChange(s => { if (s === "connected") { clientConnected = true; r(s);}}));
      const onServerConnected = new Promise(r => serverTransport.onStateChange(s => { if (s === "connected") { serverConnected = true; r(s);}}));

      clientGatherer.onIceCandidate.subscribe(async (candidate) => {
        if (candidate) await serverTransport.addRemoteCandidate(candidate);
        else await serverTransport.addRemoteCandidate(undefined);
      });
      // Server (Lite) does not send candidates proactively

      await serverGatherer.gather(); // Lite gather is quick
      await clientGatherer.gather(); // Full gather takes time

      // Exchange parameters
      serverTransport.setRemoteParams(clientGatherer.localParameters);
      clientTransport.setRemoteParams(serverGatherer.localParameters);
      
      // Start transports
      // For Lite, start primarily allows it to respond. For Full, it initiates.
      await serverTransport.start(); 
      await clientTransport.start();

      await Promise.all([onClientConnected, onServerConnected]);

      expect(clientConnected).toBe(true);
      expect(serverConnected).toBe(true);
      expect(clientTransport.state).toBe("connected");
      expect(serverTransport.state).toBe("connected");

      await clientTransport.stop();
      await serverTransport.stop();
    }, 20000); // Increased timeout for E2E test
  });

  test.skip("portRange", async () => {
    const gatherer = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      portRange: [44444, 44455],
    });

    await gatherer.gather();

    const candidates = gatherer.localCandidates;
    for (const candidate of candidates) {
      expect(inRange(candidate.port, 44444, 44455)).toBeTruthy();
    }
    await gatherer.connection.close();
  });

  test.skip("minimum target port", async () => {
    const gatherer = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      portRange: [44546, 44547],
    });

    await gatherer.gather();

    const candidates = gatherer.localCandidates;
    for (const candidate of candidates) {
      expect(inRange(candidate.port, 44546, 44547 + 1)).toBeTruthy();
    }
    await gatherer.connection.close();
  });
});
