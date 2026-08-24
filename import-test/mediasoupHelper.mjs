import { Device, detectDevice } from "mediasoup-client";
import {
  createCallbackRegister,
  installPolyfill,
} from "werift-dev/polyfill";

export function arrangeMediasoupImportPolyfill() {
  // Node 18 CI では mediasoup-client@3.16.4 を固定する（3.22+ は Node 22+）。
  const uninstall = installPolyfill({
    mediaRegister: [
      createCallbackRegister({
        mimeType: "audio/opus",
        kinds: ["audio"],
        async createTracks() {
          return [];
        },
      }),
    ],
  });

  return { uninstall };
}

export async function arrangeImportedDevice() {
  const { uninstall } = arrangeMediasoupImportPolyfill();
  const handler = detectDevice();
  const device = await Device.factory();
  return { device, handler, uninstall };
}
