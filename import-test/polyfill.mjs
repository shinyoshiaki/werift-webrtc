import { equal } from 'node:assert';
import { installPolyfill } from 'werift-dev/polyfill';

const uninstall = installPolyfill({ mediaRegister: [] });

equal(typeof globalThis.RTCPeerConnection, 'function');
const pc = new globalThis.RTCPeerConnection();
pc.createDataChannel('polyfill');
await pc.close();
uninstall();
