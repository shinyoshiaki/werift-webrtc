/**
 * Node 18 の通常 CI 向けに mediasoup-client を 3.16.4 へ固定する。
 * 3.22.0 以降は Node 22+ を要求するため、バージョンを上げるときは CI の Node matrix とセットで見直す。
 */
import { Device, detectDevice, testFakeParameters } from "mediasoup-client";

type Transport = ReturnType<Device["createSendTransport"]>;

import { MediaStreamTrack } from "../../src/media/track";
import { createCallbackRegister, installPolyfill } from "../../src/polyfill";

export { detectDevice };

export function arrangeMediasoupPolyfill() {
  const uninstall = installPolyfill({
    mediaRegister: [
      createCallbackRegister({
        mimeType: "audio/opus",
        kinds: ["audio"],
        async createTracks() {
          return [new MediaStreamTrack({ kind: "audio" })];
        },
      }),
      createCallbackRegister({
        mimeType: "video/VP8",
        kinds: ["video"],
        async createTracks() {
          return [new MediaStreamTrack({ kind: "video" })];
        },
      }),
    ],
  });

  return { uninstall };
}

export async function arrangeLoadedDevice() {
  const { uninstall } = arrangeMediasoupPolyfill();
  const device = await Device.factory();
  await device.load({
    routerRtpCapabilities: structuredClone(
      testFakeParameters.generateRouterRtpCapabilities(),
    ),
  });

  return { device, uninstall };
}

export function cloneTransportRemoteParameters() {
  return structuredClone(
    testFakeParameters.generateTransportRemoteParameters(),
  );
}

export function wireFakeSendTransport(transport: Transport) {
  transport.on("connect", (_params, callback) => {
    callback();
  });
  transport.on("produce", (_params, callback) => {
    callback({ id: testFakeParameters.generateProducerRemoteParameters().id });
  });
  transport.on("producedata", (_params, callback) => {
    callback({
      id: testFakeParameters.generateDataProducerRemoteParameters().id,
    });
  });
}

export function arrangeFakeConsumerOptions(codecMimeType: string) {
  return structuredClone(
    testFakeParameters.generateConsumerRemoteParameters({ codecMimeType }),
  );
}
