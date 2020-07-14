import * as uuid from "uuid";

export class MediaStreamTrack {
  kind = "unknown";
  ended = false;
  id = uuid.v4();
}

export class RemoteStreamTrack extends MediaStreamTrack {
  queue = [];
  constructor(public kind: string, public id: string | undefined = undefined) {
    super();
  }
}
