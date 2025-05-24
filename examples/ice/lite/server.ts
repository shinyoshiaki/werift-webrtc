import { RTCIceCandidate, RTCIceGatherer, RTCIceParameters, RTCIceTransport } from '@werift/webrtc';
import { Connection } from '@werift/ice'; // For IceOptions if needed directly
import * as readlineSync from 'readline-sync';
import { debug } from '@werift/webrtc/lib/utils'; // For logging

// Enable detailed logging for ICE components
debug.enable('werift-ice*,werift:packages/webrtc/src/transport/ice.ts');

const log = debug('lite-server');

async function main() {
  log('Starting ICE Lite Server...');

  // RTCIceGatherer is used by RTCIceTransport internally if not provided.
  // To set iceLite on the Connection, we need to configure it on RTCIceGatherer's options.
  const iceGatherer = new RTCIceGatherer({
    isLite: true, // Configure the underlying Connection to be ICE Lite
  });

  const transport = new RTCIceTransport(iceGatherer);
  // The 'iceLite' option on RTCIceTransport itself is for its awareness,
  // the actual lite mode is set on the Connection via RTCIceGatherer.

  transport.onStateChange((state) => {
    log(`Server ICE Transport State: ${state}`);
    if (state === 'connected') {
      log('Server: ICE connection established!');
    }
    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      log('Server: ICE connection lost or failed.');
      process.exit(0);
    }
  });

  transport.onIceCandidate((candidate) => {
    // ICE Lite agents do not gather candidates. This should not be called.
    if (candidate) {
      log('Server ICE Candidate (should not happen for Lite agent):', JSON.stringify(candidate.toJSON()));
    }
  });

  // Gather local parameters (uFrag, password)
  // For an ICE Lite agent, gathering is a simplified process.
  // It doesn't collect candidates but prepares local uFrag/password.
  await transport.gather();

  const localParams = transport.localParameters;
  if (!localParams || !localParams.usernameFragment || !localParams.password) {
    log.error('Server: Failed to get local ICE parameters.');
    return;
  }
  log('Server Local ICE Parameters:');
  log(`  uFrag: ${localParams.usernameFragment}`);
  log(`  Password: ${localParams.password}`);
  log(`  ICE Lite: ${localParams.iceLite}`);


  console.log('\n--- Server Local Parameters ---');
  console.log(`uFrag: ${localParams.usernameFragment}`);
  console.log(`Password: ${localParams.password}`);
  console.log('-----------------------------\n');

  log('Server: Waiting for Client ICE parameters...');

  const clientUfrag = readlineSync.question('Enter Client uFrag: ');
  const clientPassword = readlineSync.question('Enter Client Password: ');

  const remoteParams = new RTCIceParameters({
    usernameFragment: clientUfrag,
    password: clientPassword,
  });
  transport.setRemoteParams(remoteParams);

  log('Server: Waiting for Client ICE candidates...');
  console.log('Enter Client Candidates (JSON or SDP string, one per line, empty line to finish):');

  let candidateStr: string;
  while ((candidateStr = readlineSync.question('Candidate: '))) {
    try {
      let rtcCand: RTCIceCandidate | undefined;
      if (candidateStr.startsWith('{')) { // JSON
        const json = JSON.parse(candidateStr);
        rtcCand = new RTCIceCandidate(json);
      } else if (candidateStr.startsWith('a=candidate') || candidateStr.includes(" typ ")) { // SDP string
         const cand = RTCIceCandidate.fromSdp(candidateStr.replace("a=",""));
         if(cand) rtcCand = cand;
      } else {
        log.warn("Invalid candidate format, skipping:", candidateStr)
        continue;
      }

      if (rtcCand) {
        log('Server: Adding remote candidate:', JSON.stringify(rtcCand.toJSON()));
        await transport.addRemoteCandidate(rtcCand);
      }
    } catch (e: any) {
      log.error('Server: Error processing candidate:', e.message, candidateStr);
    }
  }
  log('Server: Finished adding remote candidates.');
  await transport.addRemoteCandidate(undefined); // Signal end of candidates

  // For an ICE Lite agent, it doesn't initiate the connection,
  // but it needs to be ready to respond.
  // `transport.start()` with ICE Lite doesn't actively connect but sets up.
  // The underlying Connection in werift/ice will handle incoming checks.
  // `RTCIceTransport.start()` is typically called by the controlling agent.
  // However, it also sets the transport to "checking" state and prepares it.
  // For a lite agent, it might not be strictly necessary if setRemoteParams + addRemoteCandidate
  // are enough to make the underlying Connection ready.
  // Let's call start() to ensure the transport is active.
  try {
    log('Server: Starting transport (Lite agent, will primarily respond)...');
    await transport.start(); // For Lite, this mainly transitions state and allows responding.
  } catch (error) {
    log.error('Server: Error starting ICE transport:', error);
  }

  log('Server: Setup complete. Waiting for connection...');
}

main().catch(log.error);
