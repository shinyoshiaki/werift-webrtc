import { SimpleProcessorCallbackBase } from "./interface";
import { NtpTimeBase, type NtpTimeInput, type NtpTimeOutput } from "./ntpTime";

export class NtpTimeCallback extends SimpleProcessorCallbackBase<
  NtpTimeInput,
  NtpTimeOutput,
  typeof NtpTimeBase
>(NtpTimeBase) {}
