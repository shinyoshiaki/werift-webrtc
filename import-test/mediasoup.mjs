import { equal } from "node:assert";
import { arrangeImportedDevice } from "./mediasoupHelper.mjs";

const { device, handler, uninstall } = await arrangeImportedDevice();
try {
  equal(handler, "Chrome111");
  equal(device.handlerName, "Chrome111");
  equal(typeof navigator.userAgent, "string");
} finally {
  uninstall();
}
