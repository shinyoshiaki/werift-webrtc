import { readFileSync } from "fs";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}
