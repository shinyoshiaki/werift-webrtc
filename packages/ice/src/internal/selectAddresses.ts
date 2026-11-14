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
  /**
   * The interface is a costly network (VPN / tunnel: `ipsec`, `tun`, `utun`,
   * `tap`). Its host candidate is gathered with a low local preference.
   */
  costly: boolean;
}

// https://chromium.googlesource.com/external/webrtc/+/master/rtc_base/network.cc#236
// libwebrtc gathers costly networks with a lower preference instead of
// dropping them: under a full-tunnel VPN they are the only direct path.
const costlyNetworks = ["ipsec", "tun", "utun", "tap"];
const banNetworks = ["vmnet", "veth"];

/**
 * Interface 辞書から host 候補アドレスを選別する（package-private）。
 * 公開 barrel (`src/index.ts`) からは export しない。
 * テストは本 helper への依存注入で行う。
 *
 * 公開 API `getHostAddresses()` / `nodeIpAddress()` の戻り値は従来どおりで、
 * costly な NIC（`tun` など）のアドレスは含めない。
 */
export function selectAddressesFromInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[] | undefined>,
  family: number,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
  isLinkLocal: (info: os.NetworkInterfaceInfo) => boolean,
): string[] {
  return selectHostInterfaces(interfaces, family, options, isLinkLocal)
    .filter((entry) => !entry.costly)
    .map((entry) => entry.address);
}

/**
 * gather 用に host 候補アドレスを選別する（package-private）。各アドレスの
 * NIC 名、bind 用アドレス（IPv6 リンクローカルは zone 付き）、costly かどうかを
 * 返す。`vmnet` / `veth` は除外し、costly な NIC は通常の NIC の後に並べる。
 */
export function selectHostInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[] | undefined>,
  family: number,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
  isLinkLocal: (info: os.NetworkInterfaceInfo) => boolean,
): HostInterfaceAddress[] {
  const { useLinkLocalAddress } = options;

  const all = Object.keys(interfaces).map((nic) => {
    if (banNetworks.some((word) => nic.startsWith(word))) {
      return { nic, costly: false, addresses: [] as HostInterfaceAddress[] };
    }
    const costly = costlyNetworks.some((word) => nic.startsWith(word));
    const addresses = (interfaces[nic] ?? []).filter(
      (details) =>
        normalizeFamilyNodeV18(details.family) === family &&
        !details.internal &&
        (useLinkLocalAddress ? true : !isLinkLocal(details)),
    );
    return {
      nic,
      costly,
      addresses: addresses.map((details) => ({
        address: details.address,
        nic,
        // A link-local IPv6 address is bound only with its zone.
        bindAddress:
          normalizeFamilyNodeV18(details.family) === 6 && isLinkLocal(details)
            ? `${details.address}%${nic}`
            : details.address,
        costly,
      })),
    };
  });

  // os.networkInterfaces doesn't actually return addresses in a good order.
  // have seen instances where en0 (ethernet) is after en1 (wlan), etc.
  // eth0 > eth1; costly networks come after the others.
  all.sort(
    (a, b) => Number(a.costly) - Number(b.costly) || a.nic.localeCompare(b.nic),
  );
  return all.flatMap((entry) => entry.addresses);
}
