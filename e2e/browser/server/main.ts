import express from "express";
import { datachannel } from "./handler/datachannel";
import { mediachannel_sendrecv } from "./handler/mediachannel/sendrecv";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});
app.listen(8886);

app.put("/stop", (_, res) => {
  res.send();
  process.exit();
});

datachannel(app);
mediachannel_sendrecv(app);

console.log("start");
