import type { SrtpProfile } from "../imports/rtp";

export class SrtpContext {
  srtpProfile?: SrtpProfile;

  static findMatchingSRTPProfile(remote: SrtpProfile[], local: SrtpProfile[]) {
    for (const v of local) {
      if (remote.includes(v)) return v;
    }
  }
}
