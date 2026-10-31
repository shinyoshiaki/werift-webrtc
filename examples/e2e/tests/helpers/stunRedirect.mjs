// Loaded with `--import` into example Node processes by spawnExampleNodeTs.
// Resolves the public STUN host used by the demos (and werift's default ICE
// options) to the local fixture started in tests/globalSetup.ts.
import dns from "node:dns";

const publicStunHost = "stun.l.google.com";
const localStunHost = "127.0.0.1";

const lookup = dns.promises.lookup;
dns.promises.lookup = (hostname, options) =>
  lookup(hostname === publicStunHost ? localStunHost : hostname, options);

const callbackLookup = dns.lookup;
dns.lookup = (hostname, ...rest) =>
  callbackLookup(
    hostname === publicStunHost ? localStunHost : hostname,
    ...rest,
  );
