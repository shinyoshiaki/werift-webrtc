import type { Context } from "./context/context";

export type SessionKeys = {
  localMasterKey: Buffer;
  localMasterSalt: Buffer;
  remoteMasterKey: Buffer;
  remoteMasterSalt: Buffer;
};

export type Config = {
  keys: SessionKeys;
  profile: number;
};

export class Session<T extends Context> {
  private ContextCls: any;

  localContext!: T;
  remoteContext!: T;
  onData?: (buf: Buffer) => void;

  constructor(ContextCls: any) {
    this.ContextCls = ContextCls;
  }

  start(
    localMasterKey: Buffer,
    localMasterSalt: Buffer,
    remoteMasterKey: Buffer,
    remoteMasterSalt: Buffer,
    profile: number,
  ) {
    this.localContext = new this.ContextCls(
      localMasterKey,
      localMasterSalt,
      profile,
    );
    this.remoteContext = new this.ContextCls(
      remoteMasterKey,
      remoteMasterSalt,
      profile,
    );
  }
}
