export const ProtectionProfileAes128CmHmacSha1_80 = 0x0001 as const;
export const ProtectionProfileAeadAes128Gcm = 0x0007 as const;

export const Profiles = [
  ProtectionProfileAes128CmHmacSha1_80,
  ProtectionProfileAeadAes128Gcm,
] as const;

export type SrtpProfile = (typeof Profiles)[number];

export const keyLength = (profile: SrtpProfile) => {
  switch (profile) {
    case ProtectionProfileAes128CmHmacSha1_80:
    case ProtectionProfileAeadAes128Gcm:
      return 16;
  }
};

export const saltLength = (profile: SrtpProfile) => {
  switch (profile) {
    case ProtectionProfileAes128CmHmacSha1_80:
      return 14;
    case ProtectionProfileAeadAes128Gcm:
      return 12;
  }
};
