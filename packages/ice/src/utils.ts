import * as os from "node:os";
import {
  type Address,
  type InterfaceAddresses,
  debug,
  normalizeFamilyNodeV18,
} from "./imports/common";
import { selectAddressesFromInterfaces } from "./internal/selectAddresses";
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
  const interfaces = os.networkInterfaces();
  logger(interfaces);
  return selectAddressesFromInterfaces(
    interfaces,
    family,
    { useLinkLocalAddress },
    isLinkLocalAddress,
  );
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
