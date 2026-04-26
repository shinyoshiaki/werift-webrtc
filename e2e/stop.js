const axios = require("axios");
const port = process.env.E2E_PORT ?? "8886";

axios.put(`http://localhost:${port}/stop`).catch((error) => {
  if (
    error?.code === "ECONNREFUSED" ||
    error?.code === "ECONNRESET" ||
    error?.code === "ERR_NETWORK"
  ) {
    return;
  }
  throw error;
});
