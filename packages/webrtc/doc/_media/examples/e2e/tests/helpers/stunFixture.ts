import path from "node:path";

import { NodeTurnServer } from "../../../../packages/ice-server/src";
import { e2eRoot } from "./paths.js";

/**
 * The demos (and werift's default ICE options) use this public STUN server.
 * The smoke run points it at a local fixture so gathering never waits on the
 * network.
 */
export const publicStunHost = "stun.l.google.com";
export const publicStunPort = 19302;
export const localStunHost = "127.0.0.1";

/** Preload for example Node processes: resolves `publicStunHost` to the fixture. */
export const stunRedirectPreload = path.join(
  e2eRoot,
  "tests/helpers/stunRedirect.mjs",
);

/** Answers STUN Binding requests on `localStunHost:publicStunPort` (UDP). */
export async function startLocalStun() {
  const server = new NodeTurnServer({
    host: localStunHost,
    port: publicStunPort,
    tcp: false,
  });
  await server.listen();
  return server;
}

export function rewritePublicStun(text: string) {
  return text
    .split(`stun:${publicStunHost}:${publicStunPort}`)
    .join(`stun:${localStunHost}:${publicStunPort}`);
}
