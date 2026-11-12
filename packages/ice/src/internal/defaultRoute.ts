import { createSocket } from "node:dgram";
import { isIPv6 } from "node:net";

/**
 * Public addresses the default-route probe connects to. `connect()` on a UDP
 * socket only selects the route; no packet is sent.
 */
const PROBE_TARGETS = {
  4: "8.8.8.8",
  6: "2001:4860:4860::8888",
} as const;

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
 * The local address the OS uses to reach the Internet for `family` (the source
 * address of its default route), as libwebrtc's
 * `BasicNetworkManager::QueryDefaultLocalAddress`. `undefined` without a
 * default route (package-private).
 */
export function getDefaultRouteAddress(
  family: 4 | 6,
): Promise<string | undefined> {
  return getRouteSourceAddress(PROBE_TARGETS[family]);
}

/** The default-route local address of each enabled family (package-private). */
export async function getDefaultRouteAddresses(
  useIpv4: boolean,
  useIpv6: boolean,
): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    useIpv4 ? getDefaultRouteAddress(4) : undefined,
    useIpv6 ? getDefaultRouteAddress(6) : undefined,
  ]);
  return [v4, v6].filter((address): address is string => !!address);
}
