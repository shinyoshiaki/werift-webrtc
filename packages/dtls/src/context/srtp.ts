export class SrtpContext {
  srtpProfile?: Profile;

  static findMatchingSRTPProfile(remote: Profile[], local: Profile[]) {
    for (const v of local) {
      if (remote.includes(v)) return v;
    }
  }
}

export const ProtectionProfileAes128CmHmacSha1_80 = 0x0001 as const;
export const ProtectionProfileAeadAes128Gcm = 0x0007 as const;

export const Profiles = [
  ProtectionProfileAes128CmHmacSha1_80,
  ProtectionProfileAeadAes128Gcm,
] as const;

export type Profile = (typeof Profiles)[number];
