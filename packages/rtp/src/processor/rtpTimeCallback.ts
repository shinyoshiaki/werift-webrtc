import { SimpleProcessorCallbackBase } from "./interface";
import { RtpTimeBase, RtpTimeInput, RtpTimeOutput } from "./rtpTime";

export class RtpTimeCallback extends SimpleProcessorCallbackBase<
  RtpTimeInput,
  RtpTimeOutput,
  typeof RtpTimeBase
>(RtpTimeBase) {}
