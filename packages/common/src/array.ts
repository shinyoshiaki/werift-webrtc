import mergeWith from "lodash/mergeWith";

export const deepMerge = <T>(dst: T, src: T) =>
  mergeWith(dst, src, (obj, src) => {
    if (!(src == undefined)) {
      return src;
    }
    return obj;
  });
