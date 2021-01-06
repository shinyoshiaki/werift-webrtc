import express from "express";

import { WebSocketServer, Room } from "protoo-server";
import { datachannel_answer, datachannel_offer } from "./handler/datachannel";
import {
  mediachannel_sendrecv_answer,
  mediachannel_sendrecv_offer,
} from "./handler/mediachannel/sendrecv";
import {
  mediachannel_simulcast_answer,
  mediachannel_simulcast_offer,
} from "./handler/mediachannel/simulcast";

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
app.put("/stop", (_, res) => {
  res.send();
  process.exit();
});
const http = app.listen("8886");

const server = new WebSocketServer(http);
const room = new Room();
server.on("connectionrequest", async (_, accept) => {
  const tests = {
    datachannel_answer: new datachannel_answer(),
    datachannel_offer: new datachannel_offer(),
    mediachannel_sendrecv_answer: new mediachannel_sendrecv_answer(),
    mediachannel_sendrecv_offer: new mediachannel_sendrecv_offer(),
    mediachannel_simulcast_answer: new mediachannel_simulcast_answer(),
    mediachannel_simulcast_offer: new mediachannel_simulcast_offer(),
  };

  const transport = accept();
  const peer = await room.createPeer(Math.random().toString(), transport);

  peer.on("request", (request, accept) => {
    const { type, payload } = request.data;
    tests[request.method].exec(type, payload, accept);
  });
});

console.log("start");
