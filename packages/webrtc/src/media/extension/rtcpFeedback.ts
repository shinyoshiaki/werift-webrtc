import { RTCPFB } from "../parameters";

export const useFIR = (): RTCPFB => ({ type: "ccm", parameter: "fir" });

export const useNACK = (): RTCPFB => ({ type: "nack" });

export const usePLI = (): RTCPFB => ({ type: "nack", parameter: "pli" });

export const useREMB = (): RTCPFB => ({ type: "goog-remb" });

export const useTWCC = (): RTCPFB => ({ type: "transport-cc" });
