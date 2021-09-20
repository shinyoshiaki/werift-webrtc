const { readFileSync, writeFileSync } = require("fs");

const file = readFileSync("./av1.webm");
const mod = Buffer.concat([
  file.slice(0, 257),
  Buffer.alloc(4),
  file.slice(255 + 7),
]);
writeFileSync("./mod.webm", mod);
