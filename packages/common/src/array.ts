import mergeWith from "lodash/mergeWith";

export const deepMerge = <T>(base: T, overwrite: T) =>
  mergeWith(base, overwrite, (obj, src) => {
    if (!(src == undefined)) {
      return src;
    }
    return obj;
  });

export const matchOfArrays = <T>(target: T[], source: T[]) => {
  return target.find((x) => source.find((y) => x === y));
};
