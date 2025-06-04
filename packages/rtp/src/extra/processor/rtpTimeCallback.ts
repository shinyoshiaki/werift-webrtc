import { SimpleProcessorCallbackBase } from "./interface.js";
import { RtpTimeBase, type RtpTimeInput, type RtpTimeOutput } from "./rtpTime.js";

export class RtpTimeCallback extends SimpleProcessorCallbackBase<
  RtpTimeInput,
  RtpTimeOutput,
  typeof RtpTimeBase
>(RtpTimeBase) {}
