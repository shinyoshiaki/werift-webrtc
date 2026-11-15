import { createSocket } from "node:dgram";
import * as dns from "node:dns/promises";
import { isIP, isIPv6 } from "node:net";

// The route probes `connect()` a UDP socket only to the addresses the agent
// talks to anyway (its STUN / TURN servers, a remote candidate): no packet is
// sent, and no other address (no public fallback) is probed.

const PROBE_TIMEOUT_MS = 1000;

/**
 * The local address the OS sends from to reach `target` (the source address
 * of its route), probed by `connect()` on a UDP socket. `undefined` without
 * a route (package-private).
 */
export function getRouteSourceAddress(
  target: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket(isIPv6(target) ? "udp6" : "udp4");
    let settled = false;
    const finish = (address?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(address);
    };
    const timer = setTimeout(() => finish(), PROBE_TIMEOUT_MS);
    socket.on("error", () => finish());
    try {
      socket.connect(9, target, () => {
        try {
          const address = socket.address().address.split("%")[0];
          // Some kernels "connect" without a route and keep the wildcard.
          finish(
            address === "0.0.0.0" || address === "::" ? undefined : address,
          );
        } catch {
          finish();
        }
      });
    } catch {
      finish();
    }
  });
}

/**
 * `host` as an address of `family`: an IP literal of that family as is, a
 * hostname resolved within the probe timeout. `undefined` otherwise.
 */
async function resolveProbeTarget(
  host: string,
  family: 4 | 6,
): Promise<string | undefined> {
  const literal = isIP(host);
  if (literal) return literal === family ? host : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const address = await Promise.race([
    dns
      .lookup(host, { family })
      .then(({ address }) => address)
      .catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return address;
}

/**
 * The local address the OS sends from to reach the first of `servers` (in
 * priority order) that resolves in `family` and has a route; `undefined`
 * when none does (package-private).
 */
export async function getServerRouteAddress(
  family: 4 | 6,
  servers: string[],
): Promise<string | undefined> {
  const targets = await Promise.all(
    [...new Set(servers)].map((host) => resolveProbeTarget(host, family)),
  );
  const sources = await Promise.all(
    targets.map((target) =>
      target === undefined ? undefined : getRouteSourceAddress(target),
    ),
  );
  return sources.find((source) => source !== undefined);
}

/**
 * The local address of each enabled family that gathering treats as its
 * default route: the source address of the route to the configured STUN /
 * TURN servers (`servers`, hostnames or IP literals in priority order). A
 * family without such a server has none; no public address is probed in its
 * place (package-private).
 */
export async function getDefaultRouteAddresses(
  useIpv4: boolean,
  useIpv6: boolean,
  servers: string[] = [],
): Promise<string[]> {
  if (servers.length === 0) return [];
  const [v4, v6] = await Promise.all([
    useIpv4 ? getServerRouteAddress(4, servers) : undefined,
    useIpv6 ? getServerRouteAddress(6, servers) : undefined,
  ]);
  return [v4, v6].filter((address): address is string => !!address);
}
