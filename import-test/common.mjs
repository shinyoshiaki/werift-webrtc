import { doesNotThrow, equal } from "node:assert";
import { debug } from "werift-common";

const namespace = "import-test:common";
const log = debug(namespace);

equal(typeof log, "function");
equal(log.namespace, namespace);
doesNotThrow(() => log("debug dependency is available"));
