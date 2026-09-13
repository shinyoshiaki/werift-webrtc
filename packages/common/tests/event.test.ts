import { Event } from "../src";

describe("Event", () => {
  it("isolates subscriber exceptions", () => {
    const event = new Event<[string]>();
    const received: string[] = [];
    event.subscribe(() => {
      throw new Error("first subscriber");
    });
    event.subscribe((value) => {
      received.push(value);
    });

    event.execute("ok");

    expect(received).toEqual(["ok"]);
  });
});
