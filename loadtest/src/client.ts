import { Worker } from "worker_threads";
import { ClientWorker } from "./client.worker";
import { workerThreadsWrapper, wrap } from "airpc";

const NUM = 10;

const main = async () => {
  console.log(process.env.NODE_ENV);
  const workers = [...Array(NUM)].map(() =>
    process.env.NODE_ENV === "production"
      ? new Worker(`${__dirname}/client.worker.js`)
      : new Worker(`require("ts-worker-register")`, {
          eval: true,
          workerData: { path: `${__dirname}/client.worker.ts` },
        })
  );
  const threads = workers.map((w) =>
    wrap(ClientWorker, workerThreadsWrapper(w))
  );

  await Promise.all(threads.map((t) => t.ready()));
  console.log({ NUM });

  threads.forEach((t) => t.test());
};

main();
