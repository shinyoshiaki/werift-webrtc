// チケット 36345b67 の受け入れ: チケット冒頭のコードからキャストを外したもの。
// lib.dom + skipLibCheck=false でコンパイルし、型エラーが出ないことを確かめる。
import { MediaStreamTrack as WeriftMediaStreamTrack } from "../../../src";
import {
  installPolyfill,
  MediaStream,
  MediaStreamTrack,
} from "../../../src/polyfill/dom";

// mediasoup-client の ProducerOptions / Producer / Transport を模した DOM 型の API。
interface ProducerOptions {
  track?: globalThis.MediaStreamTrack;
  appData?: Record<string, unknown>;
}
declare const sendTransport: {
  produce(options: ProducerOptions): Promise<{
    track: globalThis.MediaStreamTrack | null;
  }>;
};

export async function produceWithoutCast() {
  installPolyfill({ mediaRegister: [] });

  // チケットのコード（as unknown as ProducerOptions["track"] なし）。
  const track = new MediaStreamTrack({ kind: "audio" });
  const producer = await sendTransport.produce({
    track,
    appData: { type: "webcam" },
  });

  // werift から import した track も、そのまま渡せる。
  const weriftTrack = new WeriftMediaStreamTrack({ kind: "audio" });
  await sendTransport.produce({ track: weriftTrack });

  // werift の track でできた stream も DOM 型へ代入できる（2章 3）。
  // 逆方向（DOM 型の track を werift の API へ渡す）は推奨 8 で見送り。
  const stream: globalThis.MediaStream = new MediaStream([weriftTrack]);

  // 型は any にならず、DOM の MediaStreamTrack のまま検査される。
  // @ts-expect-error 存在しないメンバーは型エラーになる。
  producer.track?.nonexistent;

  return stream;
}
