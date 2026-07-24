import type * as os from "node:os";
import { normalizeFamilyNodeV18 } from "../imports/common";

/**
 * Interface 辞書から host 候補アドレスを選別する（package-private）。
 * 公開 barrel (`src/index.ts`) からは export しない。
 */
export function selectAddressesFromInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[] | undefined>,
  family: number,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
  isLinkLocal: (info: os.NetworkInterfaceInfo) => boolean,
): string[] {
  // https://chromium.googlesource.com/external/webrtc/+/master/rtc_base/network.cc#236
  const costlyNetworks = ["ipsec", "tun", "utun", "tap"];
  const banNetworks = ["vmnet", "veth"];
  const { useLinkLocalAddress } = options;

  const all = Object.keys(interfaces)
    .map((nic) => {
      for (const word of [...costlyNetworks, ...banNetworks]) {
        if (nic.startsWith(word)) {
          return {
            nic,
            addresses: [] as string[],
          };
        }
      }
      const addresses = (interfaces[nic] ?? []).filter(
        (details) =>
          normalizeFamilyNodeV18(details.family) === family &&
          !details.internal &&
          (useLinkLocalAddress ? true : !isLinkLocal(details)),
      );
      return {
        nic,
        addresses: addresses.map((address) => address.address),
      };
    })
    .filter((address) => !!address);

  // os.networkInterfaces doesn't actually return addresses in a good order.
  // have seen instances where en0 (ethernet) is after en1 (wlan), etc.
  // eth0 > eth1
  all.sort((a, b) => a.nic.localeCompare(b.nic));
  return Object.values(all).flatMap((entry) => entry.addresses);
}
