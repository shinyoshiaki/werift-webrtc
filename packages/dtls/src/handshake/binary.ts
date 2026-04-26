import { types } from "@shinyoshiaki/binary-data";
const { uint16be, uint24be, buffer, array, uint8, string } = types;

// export const Random = {
//   gmt_unix_time: uint32be,
//   random_bytes: buffer(28),
// };

const Extension = {
  type: uint16be,
  data: buffer(uint16be),
};

export const ExtensionList = array(Extension, uint16be, "bytes");

export const ASN11Cert = buffer(uint24be);

export const ClientCertificateType = uint8;
export const DistinguishedName = string(uint16be);

export const SignatureHashAlgorithm = { hash: uint8, signature: uint8 };

export const ProtocolVersion = { major: uint8, minor: uint8 };
