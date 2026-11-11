import * as os from "node:os";

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
