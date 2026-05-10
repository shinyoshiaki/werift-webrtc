const https = require("node:https");

async function requestServerStop(
  port = process.env.TURN_LOOPBACK_E2E_SERVER_PORT ?? "8443",
) {
  await requestJson({
    hostname: "127.0.0.1",
    port,
    path: "/stop",
    method: "PUT",
    rejectUnauthorized: false,
  }).catch((error) => {
    if (
      error?.code === "ECONNREFUSED" ||
      error?.code === "ECONNRESET" ||
      error?.cause?.code === "ECONNREFUSED" ||
      error?.cause?.code === "ECONNRESET"
    ) {
      return;
    }
    throw error;
  });
}

function requestJson(options) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(
            new Error(
              `request failed: ${response.statusCode} ${Buffer.concat(chunks).toString("utf8")}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.on("error", reject);
    request.end();
  });
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
