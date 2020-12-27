export class SrtpContext {
  srtpProfile?: number;

  static findMatchingSRTPProfile(remote: number[], local: number[]) {
    for (const v of remote) {
      if (local.includes(v)) return v;
    }
  }
}
