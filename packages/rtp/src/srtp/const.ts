export const ProtectionProfileAes128CmHmacSha1_80 = 0x0001 as const;
export const ProtectionProfileAeadAes128Gcm = 0x0007 as const;

export type Profile =
  | typeof ProtectionProfileAes128CmHmacSha1_80
  | typeof ProtectionProfileAeadAes128Gcm;

export const keyLength = (profile: Profile) => {
  switch (profile) {
    case ProtectionProfileAes128CmHmacSha1_80:
    case ProtectionProfileAeadAes128Gcm:
      return 16;
  }
};

export const saltLength = (profile: Profile) => {
  switch (profile) {
    case ProtectionProfileAes128CmHmacSha1_80:
      return 14;
    case ProtectionProfileAeadAes128Gcm:
      return 12;
  }
};
