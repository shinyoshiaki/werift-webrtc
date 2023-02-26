import { buffer2ArrayBuffer, Red, RedEncoder } from "../../../../src";

(async () => {
  // カスタムエンコーダのdistanceを3とする
  const redEncoder = new RedEncoder(3);

  // encodedInsertableStreamsを有効化しておく
  const sender = new RTCPeerConnection({
    encodedInsertableStreams: true,
  } as any);
  const receiver = new RTCPeerConnection({
    encodedInsertableStreams: true,
  } as any);

  const [track] = (
    await navigator.mediaDevices.getUserMedia({ audio: true })
  ).getTracks();

  const rtpSender = sender.addTrack(track);

  // insertableStreamsの送信側の設定をする
  const senderTransform = (sender: RTCRtpSender) => {
    //@ts-ignore
    const senderStreams = sender.createEncodedStreams();
    const readableStream = senderStreams.readable;
    const writableStream = senderStreams.writable;
    const transformStream = new TransformStream({
      transform: (encodedFrame, controller) => {
        if (encodedFrame.data.byteLength > 0) {
          // RTP Payload(REDパケット)をデシリアライズ
          const packet = Red.deSerialize(encodedFrame.data);
          // 最新のパケット(非冗長パケット)を取り出してカスタムエンコーダに渡す
          const latest = packet.blocks.at(-1);
          redEncoder.push({
            block: latest.block,
            blockPT: latest.blockPT,
            timestamp: encodedFrame.timestamp,
          });
          // カスタムエンコーダにredパケットを作らせる
          const red = redEncoder.build();
          // RTP Payloadをすり替える
          encodedFrame.data = buffer2ArrayBuffer(red.serialize());
        }
        controller.enqueue(encodedFrame);
      },
    });
    readableStream.pipeThrough(transformStream).pipeTo(writableStream);
  };
  senderTransform(rtpSender);

  const [transceiver] = sender.getTransceivers() as any;
  const { codecs } = RTCRtpSender.getCapabilities("audio");
  // REDを有効化する
  transceiver.setCodecPreferences([
    codecs.find((c) => c.mimeType.includes("red")),
    ...codecs,
  ]);

  await sender.setLocalDescription(await sender.createOffer());
  await new Promise<void>((r) => {
    sender.onicecandidate = ({ candidate }) => {
      if (!candidate) r();
    };
  });

  // insertableStreamsの受信側の設定をする
  const receiverTransform = (receiver: RTCRtpReceiver) => {
    //@ts-ignore
    const receiverStreams = receiver.createEncodedStreams();
    const readableStream: ReadableStream = receiverStreams.readable;
    const writableStream: WritableStream = receiverStreams.writable;

    const writer = writableStream.getWriter();

    const reader = readableStream.getReader();
    const read = async ({
      value,
      done,
    }: ReadableStreamReadResult<RTCEncodedAudioFrame>) => {
      if (done) {
        return;
      }
      if (value.data.byteLength > 0) {
        // RTP Payload(REDパケット)をデシリアライズ
        const red = Red.deSerialize(value.data);
        // distance値の大きさを表示
        console.log("distance", red.blocks.length - 1);
      }

      console.log(value);
      const metadata = value.getMetadata();
      const string = value.toString();

      class RTCEncodedAudioFrame {
        constructor() {}

        timestamp!: number;
        data!: ArrayBuffer;

        getMetadata() {
          return metadata;
        }
        toString() {
          return string;
        }

        get [Symbol.toStringTag]() {
          return "RTCEncodedAudioFrame";
        }
      }
      const frame = new RTCEncodedAudioFrame();
      frame.timestamp = value.timestamp;
      frame.data = value.data;

      await writer.write(value);
      console.log(frame, frame.getMetadata());
      await writer.write(frame);

      reader.read().then(read);
    };
    reader.read().then(read);
  };
  receiver.ontrack = (e) => {
    receiverTransform(e.receiver);
    const audio = document.createElement("audio");
    document.body.appendChild(audio);
    audio.srcObject = new MediaStream([e.track]);
    audio.play();
  };

  await receiver.setRemoteDescription(sender.localDescription);
  await receiver.setLocalDescription(await receiver.createAnswer());
  await sender.setRemoteDescription(receiver.localDescription);
})();
