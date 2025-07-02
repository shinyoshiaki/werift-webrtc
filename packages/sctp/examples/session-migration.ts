import { randomPort } from "../../common/src";
import { SCTP, WEBRTC_PPID } from "../src";
import { createUdpTransport } from "../src/transport";
import { createSocket } from "node:dgram";

async function main() {
  console.log("SCTP Session Migration Example with UDP Transport");
  
  // Get random ports for UDP communication
  const clientPort = await randomPort();
  const serverPort = await randomPort();
  
  console.log(`Client port: ${clientPort}, Server port: ${serverPort}`);
  
  // Create SCTP sessions with UDP transport
  const sctpA = SCTP.client(
    createUdpTransport(createSocket("udp4").bind(clientPort), {
      port: serverPort,
      address: "127.0.0.1",
    }),
  );
  const sctpB = SCTP.server(
    createUdpTransport(createSocket("udp4").bind(serverPort), {
      port: clientPort,
      address: "127.0.0.1",
    }),
  );
  
  // Set up event listeners
  sctpB.onReceive.subscribe((streamId, ppId, data) => {
    console.log(`Received from stream ${streamId}: ${data.toString()}`);
  });
  
  // Start sessions and wait for connection
  console.log("Starting SCTP sessions...");
  await Promise.all([sctpA.start(), sctpB.start()]);
  
  // Wait for connection to be established
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);
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
  
  console.log("Connection established");
  
  // Send some data from session A
  await sctpA.send(0, WEBRTC_PPID.STRING, Buffer.from("Hello from session A"));
  console.log("Sent data from session A");
  
  // Send data on multiple streams
  await sctpA.send(1, WEBRTC_PPID.STRING, Buffer.from("Stream 1 data"));
  console.log("Sent data on stream 1");
  
  // Wait a bit for data to be processed
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Export session A state
  console.log("Exporting session A state...");
  const stateBuffer = sctpA.exportState();
  console.log(`Exported state size: ${stateBuffer.length} bytes`);
  
  // Create new transport for restored session with a new port
  const newClientPort = await randomPort();
  console.log(`New client port for migration: ${newClientPort}`);
  
  const transportA2 = createUdpTransport(createSocket("udp4").bind(newClientPort), {
    port: serverPort,
    address: "127.0.0.1",
  });
  
  // Restore session from exported state
  console.log("Restoring session from exported state...");
  const sctpA2 = SCTP.restoreState(stateBuffer, transportA2);
  
  // Update server's remote port to communicate with the new client
  sctpB.setRemotePort(newClientPort);
  
  console.log("Session migrated successfully");
  console.log(`Original session state: ${sctpA.state}`);
  console.log(`Restored session state: ${sctpA2.state}`);
  console.log(`Restored session is server: ${sctpA2.isServer}`);
  console.log(`Restored session port: ${sctpA2.port}`);
  console.log(`Restored session max channels: ${sctpA2.maxChannels}`);
  
  // Stop original session
  await sctpA.stop();
  console.log("Original session stopped");
  
  // Send data from restored session
  await sctpA2.send(0, WEBRTC_PPID.STRING, Buffer.from("Hello from migrated session A"));
  console.log("Sent data from migrated session on stream 0");
  
  await sctpA2.send(1, WEBRTC_PPID.STRING, Buffer.from("Migrated stream 1 data"));
  console.log("Sent data from migrated session on stream 1");
  
  // Wait for messages to be received
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Clean up
  await sctpA2.stop();
  await sctpB.stop();
  
  console.log("Session migration example completed successfully");
}

if (require.main === module) {
  main().catch(console.error);
}