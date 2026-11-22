import * as os from "node:os";

import { normalizeFamilyNodeV18 } from "../imports/common";
import { isLinkLocalAddress } from "../utils";
import {
  type HostInterfaceAddress,
  selectHostInterfaces,
} from "./selectAddresses";

/** One enumeration of the local network interfaces. */
export type NetworkInterfaceEnumeration = {
  /** The enumerated interfaces: empty when the enumeration failed. */
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /**
   * What `os.networkInterfaces()` threw (e.g. the `SystemError` of
   * `uv_interface_addresses` where `AF_NETLINK` is not allowed).
   */
  error?: unknown;
};

/**
 * `os.networkInterfaces()` を例外なしで呼ぶ（package-private）。
 * 列挙が禁止された環境（systemd の `RestrictAddressFamilies=` で `AF_NETLINK`
 * を禁止した場合など）では Node.js が同期的に `SystemError` を throw するので、
 * 空の列挙結果と `error` を返す。呼び出し側はその世代の列挙失敗として扱う。
 */
export function readNetworkInterfaces(): NetworkInterfaceEnumeration {
  try {
    return { interfaces: os.networkInterfaces() };
  } catch (error) {
    return { interfaces: {}, error };
  }
}

/**
 * `getHostAddresses()` と同じ順序で、各アドレスの bind 用アドレス付きの
 * 列挙結果を返す（package-private）。`interfaces` を省略すると列挙し直す。
 * 列挙に失敗しても throw せず、空配列を返す（失敗は {@link readNetworkInterfaces}
 * の `error` で判定する）。
 */
export function getHostInterfaceAddresses(
  useIpv4: boolean,
  useIpv6: boolean,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
  interfaces = readNetworkInterfaces().interfaces,
): HostInterfaceAddress[] {
  const addresses: HostInterfaceAddress[] = [];
  if (useIpv4) {
    addresses.push(
      ...selectHostInterfaces(interfaces, 4, options, isLinkLocalAddress),
    );
  }
  if (useIpv6) {
    addresses.push(
      ...selectHostInterfaces(interfaces, 6, options, isLinkLocalAddress),
    );
  }
  return addresses;
}

/**
 * 候補列挙の除外条件（loopback / tun などの NIC、link-local の除外）を適用せず、
 * ローカル NIC に割り当てられた全アドレスを返す（package-private）。
 * `additionalHostAddresses` がローカル割り当てかどうかの判定に使う。
 * `interfaces` を省略すると列挙し直す。列挙に失敗しても throw せず空配列を返す
 * （その場合 `additionalHostAddresses` はすべて wildcard bind になる）。
 */
export function getAssignedInterfaceAddresses(
  interfaces = readNetworkInterfaces().interfaces,
): {
  address: string;
  bindAddress: string;
}[] {
  const result: { address: string; bindAddress: string }[] = [];
  for (const [nic, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      const isV6 = normalizeFamilyNodeV18(info.family) === 6;
      result.push({
        address: info.address,
        bindAddress:
          isV6 && isLinkLocalAddress(info)
            ? `${info.address}%${nic}`
            : info.address,
      });
    }
  }
  return result;
}
