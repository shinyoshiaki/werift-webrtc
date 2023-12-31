import { SimpleProcessorCallbackBase } from "./interface";
import { NtpTimeBase, NtpTimeInput, NtpTimeOutput } from "./ntpTime";

export class NtpTimeCallback extends SimpleProcessorCallbackBase<
  NtpTimeInput,
  NtpTimeOutput,
  typeof NtpTimeBase
>(NtpTimeBase) {}
