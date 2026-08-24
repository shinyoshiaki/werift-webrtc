import { Device, detectDevice } from "mediasoup-client";

import { RTCDataChannel } from "../../src/dataChannel";
import { MediaStreamTrack } from "../../src/media/track";
import {
  arrangeFakeConsumerOptions,
  arrangeLoadedDevice,
  arrangeMediasoupPolyfill,
  cloneTransportRemoteParameters,
  wireFakeSendTransport,
} from "./mediasoupClientTestUtils";
import {
  type AutodetectedDevice,
  readInstalledUserAgent,
} from "./mediasoupClientTypes";

describe("mediasoup-client Chrome111 control flow", () => {
  test("detectDevice and Device.factory succeed without handlerName", async () => {
    const { uninstall } = arrangeMediasoupPolyfill();
    try {
      // 実行: Handler 引数なしで検出と factory を呼ぶ。
      const handler = detectDevice();
      const device = await Device.factory();

      // 検証: Chrome111 が選ばれ、Device が生成される。
      expect(handler).toBe("Chrome111");
      expect(device.handlerName).toBe("Chrome111");
      expect(readInstalledUserAgent()).toContain("Chrome/111.0.0.0");
    } finally {
      uninstall();
    }
  });

  test("Device.load generates RTP capabilities and canProduce", async () => {
    const { device, uninstall } = await arrangeLoadedDevice();
    try {
      // 実行: fake Router capabilities で load する。
      const recv = device.rtpCapabilities;
      const typedDevice: AutodetectedDevice = device;

      // 検証: audio/video を送れ、recv capabilities が得られる。
      expect(typedDevice.loaded).toBe(true);
      expect(recv.codecs?.length).toBeGreaterThan(0);
      expect(device.canProduce("audio")).toBe(true);
      expect(device.canProduce("video")).toBe(true);
    } finally {
      uninstall();
    }
  });

  test("produce completes connect/produce callbacks with a werift track", async () => {
    const { device, uninstall } = await arrangeLoadedDevice();
    const sendTransport = device.createSendTransport(
      cloneTransportRemoteParameters(),
    );
    wireFakeSendTransport(sendTransport);
    try {
      // 実行: getUserMedia の audio track を produce する。
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const [track] = stream.getAudioTracks();
      const producer = await sendTransport.produce({ track });

      // 検証: SDP 交渉と produce callback が完了し、werift track を保持する。
      expect(producer.closed).toBe(false);
      expect(producer.kind).toBe("audio");
      expect(producer.track).toBeInstanceOf(MediaStreamTrack);
      expect(typeof producer.rtpParameters.mid).toBe("string");
      producer.close();
    } finally {
      sendTransport.close();
      uninstall();
    }
  });

  test("consume returns a live werift MediaStreamTrack", async () => {
    const { device, uninstall } = await arrangeLoadedDevice();
    const recvTransport = device.createRecvTransport(
      cloneTransportRemoteParameters(),
    );
    recvTransport.on("connect", (_params, callback) => {
      callback();
    });
    try {
      // 実行: fake Consumer パラメーターで consume する。
      const consumer = await recvTransport.consume(
        arrangeFakeConsumerOptions("audio/opus"),
      );
      const track = consumer.track as MediaStreamTrack;

      // 検証: 返却 track は werift 実装で readyState / writeRtp / onReceiveRtp を持つ。
      expect(track).toBeInstanceOf(MediaStreamTrack);
      expect(track.readyState).toBe("live");
      expect(typeof track.writeRtp).toBe("function");
      expect(track.onReceiveRtp).toBeDefined();
      consumer.close();
    } finally {
      recvTransport.close();
      uninstall();
    }
  });

  test("produceData keeps a werift RTCDataChannel", async () => {
    const { device, uninstall } = await arrangeLoadedDevice();
    const sendTransport = device.createSendTransport(
      cloneTransportRemoteParameters(),
    );
    wireFakeSendTransport(sendTransport);
    try {
      // 実行: SCTP 付き send Transport で produceData する。
      const dataProducer = await sendTransport.produceData({
        label: "werift",
        protocol: "control",
        ordered: true,
      });

      // 検証: DataProducer が werift DataChannel を保持する。
      expect(dataProducer.closed).toBe(false);
      expect(dataProducer.label).toBe("werift");
      expect(dataProducer.protocol).toBe("control");
      expect(
        (dataProducer as unknown as { _dataChannel?: unknown })._dataChannel,
      ).toBeInstanceOf(RTCDataChannel);
      dataProducer.close();
    } finally {
      sendTransport.close();
      uninstall();
    }
  });

  test("close and uninstall leave no pending rejection", async () => {
    const { device, uninstall } = await arrangeLoadedDevice();
    const sendTransport = device.createSendTransport(
      cloneTransportRemoteParameters(),
    );
    wireFakeSendTransport(sendTransport);
    const recvTransport = device.createRecvTransport(
      cloneTransportRemoteParameters(),
    );
    recvTransport.on("connect", (_params, callback) => {
      callback();
    });

    // 実行: Transport を閉じ、polyfill を外す。
    sendTransport.close();
    recvTransport.close();
    uninstall();

    // 検証: 未処理 rejection を残さない（この後の tick で落ちない）。
    await Promise.resolve();
    expect(sendTransport.closed).toBe(true);
    expect(recvTransport.closed).toBe(true);
  });
});
