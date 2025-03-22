import os from "os";
import nodeIp from "ip";
import {
  type Address,
  type InterfaceAddresses,
  debug,
  normalizeFamilyNodeV18,
} from "./imports/common";
import { classes, methods } from "./stun/const";
import { Message } from "./stun/message";
import { StunProtocol } from "./stun/protocol";

const logger = debug("werift-ice : packages/ice/src/utils.ts");

export async function getGlobalIp(
  stunServer?: Address,
  interfaceAddresses?: InterfaceAddresses,
) {
  const protocol = new StunProtocol();
  await protocol.connectionMade(true, undefined, interfaceAddresses);
  const request = new Message(methods.BINDING, classes.REQUEST);
  const [response] = await protocol.request(
    request,
    stunServer ?? ["stun.l.google.com", 19302],
  );
  await protocol.close();

  const address = response.getAttributeValue("XOR-MAPPED-ADDRESS");
  return address[0] as string;
}

export function isLinkLocalAddress(info: os.NetworkInterfaceInfo) {
  return (
    (normalizeFamilyNodeV18(info.family) === 4 &&
      info.address?.startsWith("169.254.")) ||
    (normalizeFamilyNodeV18(info.family) === 6 &&
      info.address?.startsWith("fe80::"))
  );
}

export function nodeIpAddress(
  family: number,
  {
    useLinkLocalAddress,
  }: {
    /** such as google cloud run */
    useLinkLocalAddress?: boolean;
  } = {},
): string[] {
  // https://chromium.googlesource.com/external/webrtc/+/master/rtc_base/network.cc#236
  const costlyNetworks = ["ipsec", "tun", "utun", "tap"];
  const banNetworks = ["vmnet", "veth"];

  const interfaces = os.networkInterfaces();

  logger(interfaces);

  const all = Object.keys(interfaces)
    .map((nic) => {
      for (const word of [...costlyNetworks, ...banNetworks]) {
        if (nic.startsWith(word)) {
          return {
            nic,
            addresses: [],
          };
        }
      }
      const addresses = interfaces[nic]!.filter(
        (details) =>
          normalizeFamilyNodeV18(details.family) === family &&
          !nodeIp.isLoopback(details.address) &&
          (useLinkLocalAddress ? true : !isLinkLocalAddress(details)),
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

export function getHostAddresses(
  useIpv4: boolean,
  useIpv6: boolean,
  options: {
    /** such as google cloud run */
    useLinkLocalAddress?: boolean;
  } = {},
) {
  const address: string[] = [];
  if (useIpv4) {
    address.push(...nodeIpAddress(4, options));
  }
  if (useIpv6) {
    address.push(...nodeIpAddress(6, options));
  }
  return address;
}

export const url2Address = (url?: string) => {
  if (!url) return;
  const [address, port] = url.split(":");
  return [address, Number.parseInt(port)] as Address;
};
