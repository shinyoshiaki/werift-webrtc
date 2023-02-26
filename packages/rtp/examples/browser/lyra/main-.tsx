import { LyraModule } from "@shiguredo/lyra-wasm";
import * as sdpTransform from "sdp-transform";

// WebAssembly ファイルおよびモデルファイルが配置されているディレクトリの指定
// それぞれのファイルの取得方法は後述
const wasmPath = "./";
const modelPath = "./";

(async () => {
  // 各種ファイルをロード
  const lyraModule = await LyraModule.load(wasmPath, modelPath);

  // エンコーダを生成
  const lyraEncoder = await lyraModule.createEncoder({ bitrate: 6000 });

  // デコーダを生成
  const lyraDecoder = await lyraModule.createDecoder();

  const sender = new RTCPeerConnection({
    encodedInsertableStreams: true,
  } as any);
  const receiver = new RTCPeerConnection({
    encodedInsertableStreams: true,
  } as any);

  const [track] = (
    await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })
  ).getTracks();

  const rtpSender = sender.addTrack(track);

  const senderTransform = (sender: RTCRtpSender) => {
    const senderStreams = (sender as any).createEncodedStreams();
    const readableStream = senderStreams.readable;
    const writableStream = senderStreams.writable;
    const transformStream = new TransformStream({
      transform: async (encodedFrame, controller) => {
        const view = new DataView(encodedFrame.data);
        const rawData = new Int16Array(encodedFrame.data.byteLength / 2);
        for (let i = 0; i < encodedFrame.data.byteLength; i += 2) {
          rawData[i / 2] = view.getInt16(i, false);
        }
        console.log(
          encodedFrame.data,
          new Uint8Array(encodedFrame.data),
          view,
          rawData
        );
        const encoded = await lyraEncoder.encode(rawData);

        if (encoded === undefined) {
          return;
        }
        encodedFrame.data = encoded.buffer;
        controller.enqueue(encodedFrame);
      },
    });
    readableStream.pipeThrough(transformStream).pipeTo(writableStream);
  };
  senderTransform(rtpSender);

  const offer = await sender.createOffer();
  const offerSdp = sdpTransform.parse(offer.sdp ?? "");
  {
    const defaultRtp = offerSdp.media[0].rtp;
    const [lastPt] = defaultRtp.map((r) => r.payload).reverse();
    const l16Pt = lastPt + 1;
    offerSdp.media[0].rtp = [
      { payload: l16Pt, codec: "L16", rate: 16000 },
      ...defaultRtp,
    ];
    offerSdp.media[0].payloads = `${l16Pt} ${offerSdp.media[0].payloads}`;
  }
  const mungingOffer = sdpTransform.write(offerSdp);
  console.log(mungingOffer);
  await sender.setLocalDescription({ sdp: mungingOffer, type: "offer" });
  await new Promise<void>((r) => {
    sender.onicecandidate = ({ candidate }) => {
      if (!candidate) r();
    };
  });
  console.log(sender.localDescription.sdp);
  await receiver.setRemoteDescription(sender.localDescription);

  const answer = await receiver.createAnswer();
  const answerSdp = sdpTransform.parse(answer.sdp ?? "");
  {
    const defaultRtp = answerSdp.media[0].rtp;
    const [lastPt] = defaultRtp.map((r) => r.payload).reverse();
    const l16Pt = lastPt + 1;
    answerSdp.media[0].rtp = [
      { payload: l16Pt, codec: "L16", rate: 16000 },
      ...defaultRtp,
    ];
    answerSdp.media[0].payloads = `${l16Pt} ${answerSdp.media[0].payloads}`;
  }
  const mungingAnswer = sdpTransform.write(answerSdp);
  console.log(mungingAnswer);
  await receiver.setLocalDescription({ type: "answer", sdp: mungingAnswer });

  await sender.setRemoteDescription(receiver.localDescription);
})();
