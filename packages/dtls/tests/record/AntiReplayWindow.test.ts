import { AntiReplayWindow } from "../../src/record/antiReplayWindow";

describe("AntiReplayWindow =>", () => {
  it("constructor & reset", () => {
    const wnd = new AntiReplayWindow() as any;
    expect(wnd.window).toEqual([0, 0]);
    expect(wnd.ceiling).toEqual(63);
    // put bullshit data in
    wnd.window = [1, 2, 3];
    wnd.ceiling = -1;
    // reset
    wnd.reset();
    expect(wnd.window).toEqual([0, 0]);
    expect(wnd.ceiling).toEqual(63);
  });

  it("usage 1", () => {
    const wnd = new AntiReplayWindow();
    // test some seq_numbers against the default window (0..63)
    expect(wnd.hasReceived(-1)).toBe(false);
    expect(wnd.mayReceive(-1)).toBe(false);
    expect(wnd.hasReceived(0)).toBe(false);
    expect(wnd.mayReceive(0)).toBe(true);
    expect(wnd.hasReceived(63)).toBe(false);
    expect(wnd.mayReceive(63)).toBe(true);
    expect(wnd.hasReceived(64)).toBe(false);
    expect(wnd.mayReceive(64)).toBe(true);
    expect(wnd.hasReceived(127)).toBe(false);
    expect(wnd.mayReceive(127)).toBe(true);
    // above ceiling+width we should discard the packets
    expect(wnd.hasReceived(128)).toBe(false);
    expect(wnd.mayReceive(128)).toBe(false);

    // receive a packet
    expect(wnd.hasReceived(5)).toBe(false);
    wnd.markAsReceived(5);
    expect(wnd.hasReceived(5)).toBe(true);
    // the window should still be the same
    // tslint:disable-next-line:no-string-literal
    expect(wnd["window"]).toEqual([1 << 5, 0]);
    // tslint:disable-next-line:no-string-literal
    expect(wnd["ceiling"]).toEqual(63);

    // now receive one outside the window
    wnd.markAsReceived(65);
    expect(wnd.hasReceived(5)).toBe(true);
    expect(wnd.hasReceived(65)).toBe(true);
    expect(wnd.mayReceive(1)).toBe(false);
    expect(wnd.mayReceive(5)).toBe(false);
    expect(wnd.mayReceive(65)).toBe(false);

    // now make a larger step
    wnd.markAsReceived(100);
    // 5 should already be outside the window
    expect(wnd.hasReceived(5)).toBe(false);
    expect(wnd.hasReceived(65)).toBe(true);
    expect(wnd.hasReceived(100)).toBe(true);
  });
});
