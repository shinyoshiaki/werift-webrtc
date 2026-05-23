import type { Address } from "../../../packages/common/src";

export type ClientTransportKey = string;
export type FrontProxyTransport = "tcp";

export type RelayToTurnFrame = {
  clientTransportKey: ClientTransportKey;
  payload: Buffer;
};

export type ClientTransportAddress = {
  ip: string;
  port: number;
};

export type PublicTurnAddress = {
  ip: string;
  port: number;
  transport: FrontProxyTransport;
};

export type RelayConnectionContext = {
  originalClientAddress: ClientTransportAddress;
  publicTurnAddress: PublicTurnAddress;
};

export function addressTuple(address: ClientTransportAddress): Address {
  return [address.ip, address.port];
}

export function publicAddressTuple(address: PublicTurnAddress): Address {
  return [address.ip, address.port];
}

export function formatAddress(
  address: Pick<ClientTransportAddress, "ip" | "port">,
) {
  return `${address.ip}:${address.port}`;
}

export function computeClientTransportKey({
  originalClientAddress,
  publicTurnAddress,
}: RelayConnectionContext): ClientTransportKey {
  return [
    formatAddress(originalClientAddress),
    `${publicTurnAddress.ip}:${publicTurnAddress.port}`,
    publicTurnAddress.transport,
  ].join("|");
}
