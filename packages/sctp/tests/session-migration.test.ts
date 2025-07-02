import { describe, it, expect, beforeEach } from "vitest";
import { randomPort } from "../../common/src";
import { SCTP, WEBRTC_PPID } from "../src";
import { createUdpTransport } from "../src/transport";
import { createSocket } from "node:dgram";

describe("SCTP Session Migration", () => {
  let clientPort: number;
  let serverPort: number;
  let sctpA: SCTP;
  let sctpB: SCTP;

  beforeEach(async () => {
    clientPort = await randomPort();
    serverPort = await randomPort();
    
    sctpA = SCTP.client(
      createUdpTransport(createSocket("udp4").bind(clientPort), {
        port: serverPort,
        address: "127.0.0.1",
      }),
    );
    sctpB = SCTP.server(
      createUdpTransport(createSocket("udp4").bind(serverPort), {
        port: clientPort,
        address: "127.0.0.1",
      }),
    );
  });

  it("should export and restore session state", async () => {
    // Start connection and establish
    await Promise.all([sctpA.start(), sctpB.start()]);
    
    // Wait for connection to be established
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 3000);
      const checkConnection = () => {
        if (sctpA.state === "connected" && sctpB.state === "connected") {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 10);
        }
      };
      checkConnection();
    });

    // Send some data to create session state
    const testData = Buffer.from("test message");
    await sctpA.send(0, WEBRTC_PPID.STRING, testData);
    
    // Wait for data to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Export state from sctpA
    const stateBuffer = sctpA.exportState();
    expect(stateBuffer).toBeInstanceOf(Buffer);
    expect(stateBuffer.length).toBeGreaterThan(0);

    // Create new transport that will be used by restored session
    const newClientPort = await randomPort();
    const transportA2 = createUdpTransport(createSocket("udp4").bind(newClientPort), {
      port: serverPort,
      address: "127.0.0.1",
    });

    // Restore session from exported state
    const sctpA2 = SCTP.restoreState(stateBuffer, transportA2);
    
    // Verify that the restored session has the same state
    expect(sctpA2.associationState).toBe(sctpA.associationState);
    expect(sctpA2.started).toBe(sctpA.started);
    expect(sctpA2.isServer).toBe(sctpA.isServer);
    expect(sctpA2.port).toBe(sctpA.port);
    
    // Stop the old session and clean up
    await sctpA.stop();
    await sctpB.stop();
  }, 10000);

  it("should handle session migration with real data transfer", async () => {
    let receivedMessages: string[] = [];
    
    // Set up receiver
    sctpB.onReceive.subscribe((streamId, ppId, data) => {
      receivedMessages.push(data.toString());
    });
    
    // Start connection and establish
    await Promise.all([sctpA.start(), sctpB.start()]);
    
    // Wait for connection to be established
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 3000);
      const checkConnection = () => {
        if (sctpA.state === "connected" && sctpB.state === "connected") {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 10);
        }
      };
      checkConnection();
    });

    // Send initial messages
    await sctpA.send(0, WEBRTC_PPID.STRING, Buffer.from("message1"));
    await sctpA.send(0, WEBRTC_PPID.STRING, Buffer.from("message2"));
    
    // Wait for messages to be received
    await new Promise(resolve => setTimeout(resolve, 200));

    // Export state during active communication
    const stateBuffer = sctpA.exportState();
    
    // Create new transport and restore session
    const newClientPort = await randomPort();
    const transportA2 = createUdpTransport(createSocket("udp4").bind(newClientPort), {
      port: serverPort,
      address: "127.0.0.1",
    });
    const sctpA2 = SCTP.restoreState(stateBuffer, transportA2);
    
    // Update server's remote port to the new client port
    sctpB.setRemotePort(newClientPort);
    
    // Stop old session
    await sctpA.stop();
    
    // Continue communication with restored session
    await sctpA2.send(0, WEBRTC_PPID.STRING, Buffer.from("migrated1"));
    await sctpA2.send(0, WEBRTC_PPID.STRING, Buffer.from("migrated2"));
    
    // Wait for messages to be received
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify messages were received
    expect(receivedMessages).toContain("message1");
    expect(receivedMessages).toContain("message2");
    expect(receivedMessages).toContain("migrated1");
    expect(receivedMessages).toContain("migrated2");

    // Clean up
    await sctpA2.stop();
    await sctpB.stop();
  }, 15000);

  it("should preserve stream state across migration", async () => {
    let receivedData: { streamId: number; data: string }[] = [];
    
    // Set up receiver
    sctpB.onReceive.subscribe((streamId, ppId, data) => {
      receivedData.push({ streamId, data: data.toString() });
    });
    
    // Start connection and establish
    await Promise.all([sctpA.start(), sctpB.start()]);
    
    // Wait for connection to be established
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 3000);
      const checkConnection = () => {
        if (sctpA.state === "connected" && sctpB.state === "connected") {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 10);
        }
      };
      checkConnection();
    });

    // Send data on multiple streams
    await sctpA.send(0, WEBRTC_PPID.STRING, Buffer.from("stream0"));
    await sctpA.send(1, WEBRTC_PPID.STRING, Buffer.from("stream1"));
    
    // Wait for data to be processed
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Export and restore state
    const stateBuffer = sctpA.exportState();
    const newClientPort = await randomPort();
    const transportA2 = createUdpTransport(createSocket("udp4").bind(newClientPort), {
      port: serverPort,
      address: "127.0.0.1",
    });
    const sctpA2 = SCTP.restoreState(stateBuffer, transportA2);
    
    // Verify stream state is preserved
    expect(sctpA2.maxChannels).toBe(sctpA.maxChannels);
    
    // Update server's remote port
    sctpB.setRemotePort(newClientPort);
    
    // Stop old session
    await sctpA.stop();
    
    // Continue using streams with restored session
    await sctpA2.send(0, WEBRTC_PPID.STRING, Buffer.from("restored stream0"));
    await sctpA2.send(1, WEBRTC_PPID.STRING, Buffer.from("restored stream1"));
    
    // Wait for data to be processed
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify data was received on correct streams
    expect(receivedData.find(d => d.streamId === 0 && d.data === "stream0")).toBeDefined();
    expect(receivedData.find(d => d.streamId === 1 && d.data === "stream1")).toBeDefined();
    expect(receivedData.find(d => d.streamId === 0 && d.data === "restored stream0")).toBeDefined();
    expect(receivedData.find(d => d.streamId === 1 && d.data === "restored stream1")).toBeDefined();

    await sctpA2.stop();
    await sctpB.stop();
  }, 15000);
});