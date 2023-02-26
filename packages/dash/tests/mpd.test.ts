import { MPD } from "../src/mpd";

describe("mpd", () => {
  test("test", () => {
    const str = new MPD().build();
    console.log(str);
    str;
  });
});
