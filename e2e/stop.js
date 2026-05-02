const axios = require("axios");

async function requestServerStop(port = process.env.E2E_PORT ?? "8886") {
  try {
    await axios.put(`http://localhost:${port}/stop`);
  } catch (error) {
    if (
      error?.code === "ECONNREFUSED" ||
      error?.code === "ECONNRESET" ||
      error?.code === "ERR_NETWORK"
    ) {
      return;
    }
    throw error;
  }
}

module.exports = {
  requestServerStop,
};

if (require.main === module) {
  requestServerStop().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
