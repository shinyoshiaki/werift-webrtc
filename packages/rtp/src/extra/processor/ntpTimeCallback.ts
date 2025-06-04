import { SimpleProcessorCallbackBase } from "./interface.js";
import { NtpTimeBase, type NtpTimeInput, type NtpTimeOutput } from "./ntpTime.js";

export class NtpTimeCallback extends SimpleProcessorCallbackBase<
  NtpTimeInput,
  NtpTimeOutput,
  typeof NtpTimeBase
>(NtpTimeBase) {}
