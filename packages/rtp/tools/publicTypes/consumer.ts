// 生成された公開宣言を skipLibCheck: false で検査するための利用側コード
import {
  DtxCallback,
  type LipSyncOptions,
  SimpleProcessorCallbackBase,
} from "../../.tmp-decl/rtp/src/extra";

class StaticBase {
  protected static setting = 7;
  static version = 3;
  processInput(input: number): number[] {
    return [input];
  }
  toJSON() {
    return {};
  }
}

class Custom extends SimpleProcessorCallbackBase<
  number,
  number,
  typeof StaticBase
>(StaticBase) {
  reset() {
    return Custom.setting;
  }
}

export const version: number = Custom.version;
export const reset: number = new Custom().pipe(() => {}).reset();
export const piped: DtxCallback = new DtxCallback(1, Buffer.alloc(0)).pipe(
  () => {},
);

// 後から追加したオプション（kinds / startTimeout）を省略した従来の全指定が型エラーにならないこと
export const legacyLipSyncOptions: LipSyncOptions = {
  syncInterval: 500,
  bufferLength: 10,
  fillDummyAudioPacket: Buffer.alloc(0),
  ptime: 20,
};
