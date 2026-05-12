import { equal } from "node:assert";
import { debug } from "werift-common";

const log = debug("import-test:common");

equal(typeof log, "function");
