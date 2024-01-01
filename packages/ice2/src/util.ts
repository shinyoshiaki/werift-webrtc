import { Address } from "./model";

export function normalizeFamilyNodeV18(family: string | number): 4 | 6 {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;

  return family as 4 | 6;
}

export const str2Address = (str: string): Address => {
  const [host, port] = str.split(":");
  return [host, Number(port)];
};

export const address2Str = (address: Address): string => {
  return address.join(":");
};
