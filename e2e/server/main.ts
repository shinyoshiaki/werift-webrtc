import express from "express";

import { WebSocketServer, Room } from "protoo-server";
import {
  datachannel_close_client_create_close,
  datachannel_close_client_create_server_close,
  datachannel_close_server_create_client_close,
  datachannel_close_server_create_close,
} from "./handler/datachannel/close";
import {
  datachannel_answer,
  datachannel_offer,
} from "./handler/datachannel/datachannel";
import { ice_trickle_answer, ice_trickle_offer } from "./handler/ice/trickle";
import {
  mediachannel_addTrack_answer,
  mediachannel_addTrack_offer,
} from "./handler/mediachannel/addTrack";
import {
  mediachannel_rtx_client_answer,
  mediachannel_rtx_client_offer,
} from "./handler/mediachannel/rtx";
import {
  mediachannel_oneway_answer,
  mediachannel_oneway_offer,
} from "./handler/mediachannel/oneway";
import {
  mediachannel_sendrecv_answer,
  mediachannel_sendrecv_offer,
} from "./handler/mediachannel/sendrecv";
import {
  mediachannel_simulcast_answer,
  mediachannel_simulcast_offer,
} from "./handler/mediachannel/simulcast";
import {
  mediachannel_red_client_answer,
  mediachannel_red_client_offer,
} from "./handler/mediachannel/red";
import {
  combination_all_media_answer,
  combination_all_media_offer,
} from "./handler/combination/allmedia";
import {
  bundle_max_compat_answer,
  bundle_max_compat_offer,
} from "./handler/bundle/max-compat";
import {
  bundle_disable_answer,
  bundle_disable_offer,
} from "./handler/bundle/disable";
import {
  bundle_max_bundle_answer,
  bundle_max_bundle_offer,
} from "./handler/bundle/max-bundle";
import {
  mediachannel_addtrack_removefirst_addtrack,
  mediachannel_removetrack_addtrack,
  mediachannel_offer_replace_second,
} from "./handler/mediachannel/removeTrack";

const app = express();
app.use(express.json() as never);
app.use(express.urlencoded({ extended: true }) as never);
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
    mediachannel_oneway_answer: new mediachannel_oneway_answer(),
    mediachannel_oneway_offer: new mediachannel_oneway_offer(),
    mediachannel_addTrack_answer: new mediachannel_addTrack_answer(),
    mediachannel_addTrack_offer: new mediachannel_addTrack_offer(),
    datachannel_close_server_create_close:
      new datachannel_close_server_create_close(),
    datachannel_close_client_create_close:
      new datachannel_close_client_create_close(),
    datachannel_close_client_create_server_close:
      new datachannel_close_client_create_server_close(),
    datachannel_close_server_create_client_close:
      new datachannel_close_server_create_client_close(),
    ice_trickle_answer: new ice_trickle_answer(),
    ice_trickle_offer: new ice_trickle_offer(),
    mediachannel_rtx_client_answer: new mediachannel_rtx_client_answer(),
    mediachannel_rtx_client_offer: new mediachannel_rtx_client_offer(),
    mediachannel_red_client_answer: new mediachannel_red_client_answer(),
    mediachannel_red_client_offer: new mediachannel_red_client_offer(),
    combination_all_media_answer: new combination_all_media_answer(),
    combination_all_media_offer: new combination_all_media_offer(),
    bundle_max_compat_answer: new bundle_max_compat_answer(),
    bundle_max_compat_offer: new bundle_max_compat_offer(),
    bundle_disable_answer: new bundle_disable_answer(),
    bundle_disable_offer: new bundle_disable_offer(),
    bundle_max_bundle_answer: new bundle_max_bundle_answer(),
    bundle_max_bundle_offer: new bundle_max_bundle_offer(),
    mediachannel_removetrack_addtrack: new mediachannel_removetrack_addtrack(),
    mediachannel_addtrack_removefirst_addtrack:
      new mediachannel_addtrack_removefirst_addtrack(),
    mediachannel_offer_replace_second: new mediachannel_offer_replace_second(),
  };

  const transport = accept();
  const peer = await room.createPeer(Math.random().toString(), transport);

  peer.on("request", async (request, accept) => {
    const { type, payload } = request.data;
    try {
      await tests[request.method].exec(type, payload, accept, peer);
    } catch (error) {
      console.log(error);
    }
  });
});

console.log("start");
