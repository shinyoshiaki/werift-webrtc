import { RTCIceCandidate, RTCIceGatherer, RTCIceParameters, RTCIceTransport } from '@werift/webrtc';
import * as readlineSync from 'readline-sync';
import { debug } from '@werift/webrtc/lib/utils'; // For logging

// Enable detailed logging for ICE components
debug.enable('werift-ice*,werift:packages/webrtc/src/transport/ice.ts');

const log = debug('full-client');

async function main() {
  log('Starting Full ICE Client...');

  // Default is full ICE agent
  const iceGatherer = new RTCIceGatherer({ isLite: false });
  const transport = new RTCIceTransport(iceGatherer);

  transport.onStateChange((state) => {
    log(`Client ICE Transport State: ${state}`);
    if (state === 'connected') {
      log('Client: ICE connection established!');
    }
    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      log('Client: ICE connection lost or failed.');
      process.exit(0);
    }
  });

  const localCandidates: RTCIceCandidate[] = [];
  transport.onIceCandidate((candidate) => {
    if (candidate) {
      log('Client ICE Candidate:', JSON.stringify(candidate.toJSON()));
      localCandidates.push(candidate);
      // For this example, we'll print them after gathering local parameters
    } else {
      log('Client: End of candidates.');
      // Print all candidates once gathering is complete
      console.log('\n--- Client Local Candidates ---');
      localCandidates.forEach(cand => {
        // It's often easier to copy/paste the SDP line directly
        console.log(cand.candidate);
      });
      console.log('------------------------------\n');
      log('Client: All local candidates gathered and printed.');
    }
  });

  log('Client: Waiting for Server ICE parameters...');
  const serverUfrag = readlineSync.question('Enter Server uFrag: ');
  const serverPassword = readlineSync.question('Enter Server Password: ');

  const remoteParams = new RTCIceParameters({
    usernameFragment: serverUfrag,
    password: serverPassword,
    iceLite: true, // The remote is ICE Lite
  });
  transport.setRemoteParams(remoteParams);


  // Gather local parameters (uFrag, password) and candidates
  log('Client: Gathering local candidates...');
  await transport.gather(); // This will trigger onIceCandidate events

  const localParams = transport.localParameters;
  if (!localParams || !localParams.usernameFragment || !localParams.password) {
    log.error('Client: Failed to get local ICE parameters.');
    return;
  }

  log('Client Local ICE Parameters:');
  log(`  uFrag: ${localParams.usernameFragment}`);
  log(`  Password: ${localParams.password}`);
  log(`  ICE Lite: ${localParams.iceLite}`);

  console.log('\n--- Client Local Parameters ---');
  console.log(`uFrag: ${localParams.usernameFragment}`);
  console.log(`Password: ${localParams.password}`);
  console.log('-----------------------------\n');
  
  // Note: Candidates are printed by the onIceCandidate callback when it receives a null candidate (end of gathering)

  log('Client: Ready to start ICE. Ensure server has client uFrag, password, and candidates.');
  readlineSync.question('Press Enter to start ICE connection attempt once server is ready with client details...');

  try {
    log('Client: Starting transport (Full agent, will initiate checks)...');
    await transport.start();
  } catch (error) {
    log.error('Client: Error starting ICE transport:', error);
  }

  log('Client: Setup complete. Waiting for connection...');
}

main().catch(log.error);
