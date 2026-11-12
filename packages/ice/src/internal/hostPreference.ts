import { normalizeIp } from "./resolveHostAddresses";

/**
 * Local preference tiers of UDP host candidates (RFC 8445 §5.1.2.1). The
 * default-route address (the route to the configured STUN / TURN server, else
 * to the Internet) comes first, so checks start with the path the
 * OS would use; costly networks (VPN / tunnel) come last, as in libwebrtc.
 * Within a tier the preference decreases with the gathering order, so every
 * host candidate of a component has its own value.
 * @enum
 */
export const HostLocalPreference = {
  defaultRoute: 65535,
  normal: 32767,
  costly: 16383,
} as const;
/** @enum */
export type HostLocalPreference =
  (typeof HostLocalPreference)[keyof typeof HostLocalPreference];

/**
 * The local preference of each host address, in the order of `hosts`
 * (package-private).
 */
export function hostLocalPreferences(
  hosts: { address: string; costly?: boolean }[],
  defaultRoutes: string[],
): number[] {
  const defaults = new Set(defaultRoutes.map(normalizeIp));
  const used = { defaultRoute: 0, normal: 0, costly: 0 };
  return hosts.map(({ address, costly }) => {
    const tier = defaults.has(normalizeIp(address))
      ? "defaultRoute"
      : costly
        ? "costly"
        : "normal";
    const preference = HostLocalPreference[tier] - used[tier];
    used[tier]++;
    return Math.max(preference, 1);
  });
}
