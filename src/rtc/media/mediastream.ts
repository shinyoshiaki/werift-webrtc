import * as uuid from "uuid";
import { Kind } from "../../typings/domain";

export class MediaStreamTrack {
  kind: Kind = "unknown";
  ended = false;
  id = uuid.v4();
}

export class RemoteStreamTrack extends MediaStreamTrack {
  queue = [];
  constructor(public kind: Kind, public id: string | undefined = undefined) {
    super();
  }
}
