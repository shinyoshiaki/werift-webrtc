async function requestServerStop(port = process.env.CHROME_E2E_PORT ?? "8887") {
  try {
    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: "PUT",
    });
  } catch (error) {
    if (
      error?.cause?.code === "ECONNREFUSED" ||
      error?.cause?.code === "ECONNRESET"
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
