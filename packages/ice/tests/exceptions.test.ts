import { TransactionFailed, TransactionTimeout } from "../src/exceptions";
import { classes, methods } from "../src/stun/const";
import { Message } from "../src/stun/message";

describe("exceptions", () => {
  test("test_transaction_failed", () => {
    const response = new Message(methods.BINDING, classes.RESPONSE);
    response.setAttribute("ERROR-CODE", [487, "Role Conflict"]);
    const exc = new TransactionFailed(response, ["", 0]);
    expect(exc.str).toBe("STUN transaction failed (487 - Role Conflict)");
  });

  test("test_transaction_timeout", () => {
    const exc = new TransactionTimeout();
    expect(exc.str).toBe("STUN transaction timed out");
  });
});
