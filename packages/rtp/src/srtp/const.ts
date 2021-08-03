export const ProtectionProfileAes128CmHmacSha1_80 = 0x0001 as const;
export const ProtectionProfileAeadAes128Gcm = 0x0007 as const;

export type Profile =
  | typeof ProtectionProfileAes128CmHmacSha1_80
  | typeof ProtectionProfileAeadAes128Gcm;
