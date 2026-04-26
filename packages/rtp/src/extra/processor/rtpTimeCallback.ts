import { SimpleProcessorCallbackBase } from "./interface";
import { RtpTimeBase, type RtpTimeInput, type RtpTimeOutput } from "./rtpTime";

export class RtpTimeCallback extends SimpleProcessorCallbackBase<
  RtpTimeInput,
  RtpTimeOutput,
  typeof RtpTimeBase
>(RtpTimeBase) {}
