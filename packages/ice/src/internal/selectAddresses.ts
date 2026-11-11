import type * as os from "node:os";
import { normalizeFamilyNodeV18 } from "../imports/common";

/** A host address enumerated from a local network interface. */
export interface HostInterfaceAddress {
  address: string;
  /** Name of the interface the address belongs to. */
  nic: string;
  /**
   * Address a socket binds for `address`: an IPv6 link-local address carries
   * its zone (`fe80::1%eth0`), any other address is `address` itself.
   */
  bindAddress: string;
}

/**
 * Interface 辞書から host 候補アドレスを選別する（package-private）。
 * 公開 barrel (`src/index.ts`) からは export しない。
 * テストは本 helper への依存注入で行う。
 */
export function selectAddressesFromInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[] | undefined>,
  family: number,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
  isLinkLocal: (info: os.NetworkInterfaceInfo) => boolean,
): string[] {
  return selectHostInterfaces(interfaces, family, options, isLinkLocal).map(
    (entry) => entry.address,
  );
}

/**
 * `selectAddressesFromInterfaces` と同じ選別・順序で、各アドレスの NIC 名と
 * bind 用アドレス（IPv6 リンクローカルは zone 付き）を返す（package-private）。
 */
export function selectHostInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[] | undefined>,
  family: number,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
  isLinkLocal: (info: os.NetworkInterfaceInfo) => boolean,
): HostInterfaceAddress[] {
  // https://chromium.googlesource.com/external/webrtc/+/master/rtc_base/network.cc#236
  const costlyNetworks = ["ipsec", "tun", "utun", "tap"];
  const banNetworks = ["vmnet", "veth"];
  const { useLinkLocalAddress } = options;

  const all = Object.keys(interfaces).map((nic) => {
    for (const word of [...costlyNetworks, ...banNetworks]) {
      if (nic.startsWith(word)) {
        return { nic, addresses: [] as HostInterfaceAddress[] };
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
      addresses: addresses.map((details) => ({
        address: details.address,
        nic,
        // A link-local IPv6 address is bound only with its zone.
        bindAddress:
          normalizeFamilyNodeV18(details.family) === 6 && isLinkLocal(details)
            ? `${details.address}%${nic}`
            : details.address,
      })),
    };
  });

  // os.networkInterfaces doesn't actually return addresses in a good order.
  // have seen instances where en0 (ethernet) is after en1 (wlan), etc.
  // eth0 > eth1
  all.sort((a, b) => a.nic.localeCompare(b.nic));
  return all.flatMap((entry) => entry.addresses);
}
