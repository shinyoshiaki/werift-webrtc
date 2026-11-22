import * as os from "node:os";

import { normalizeFamilyNodeV18 } from "../imports/common";
import { isLinkLocalAddress } from "../utils";
import {
  type HostInterfaceAddress,
  selectHostInterfaces,
} from "./selectAddresses";

/**
 * `getHostAddresses()` と同じ順序で、各アドレスの bind 用アドレス付きの
 * 列挙結果を返す（package-private）。
 */
export function getHostInterfaceAddresses(
  useIpv4: boolean,
  useIpv6: boolean,
  options: {
    useLinkLocalAddress?: boolean;
  } = {},
): HostInterfaceAddress[] {
  const interfaces = os.networkInterfaces();
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
 */
export function getAssignedInterfaceAddresses(): {
  address: string;
  bindAddress: string;
}[] {
  const result: { address: string; bindAddress: string }[] = [];
  for (const [nic, infos] of Object.entries(os.networkInterfaces())) {
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
