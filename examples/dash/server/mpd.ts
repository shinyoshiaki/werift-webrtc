import { create } from "xmlbuilder2";
import { XMLBuilder } from "xmlbuilder2/lib/interfaces";

export class MPD {
  private root: XMLBuilder;
  initialization: string = "init.webm";
  media: string = "media$Time$.webm";
  availabilityStartTime = new Date().toISOString();
  publishTime = new Date().toISOString();
  segmentationTimeLine: {
    /**duration ms */
    d: number;
    /**
     * timestamp ms
     * dの合計値
     */
    t?: number;
  }[] = [];
  codecs = ["vp8", "opus"];
  minimumUpdatePeriod = 1;
  minBufferTime = 2;
  width = 1920;
  height = 1080;

  constructor(props: Partial<MPD> = {}) {
    Object.assign(this, props);

    this.root = this.create();
  }

  private create() {
    return create({
      MPD: {
        ...toAttributes({
          "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
          xmlns: "urn:mpeg:dash:schema:mpd:2011",
          "xsi:schemaLocation": "urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd",
          profiles:
            "urn:mpeg:dash:profile:isoff-live:2011,http://dashif.org/guidelines/dash-if-simple",
          type: "dynamic",
          availabilityStartTime: this.availabilityStartTime,
          publishTime: this.publishTime,
          minimumUpdatePeriod: `PT${this.minimumUpdatePeriod}S`,
          minBufferTime: `PT${this.minBufferTime}S`,
        }),
        Period: {
          ...toAttributes({ start: "PT0S", id: "1" }),
          AdaptationSet: {
            ...toAttributes({ mimeType: "video/webm" }),
            ContentComponent: {
              ...toAttributes({ contentType: "video", id: 1 }),
            },
            Representation: {
              ...toAttributes({
                id: "1",
                width: this.width,
                height: this.height,
                codecs: this.codecs.join(","),
              }),
              SegmentTemplate: {
                ...toAttributes({
                  timescale: 1000,
                  initialization: this.initialization,
                  media: this.media,
                  presentationTimeOffset: 0,
                }),
                SegmentTimeline: {
                  S: this.segmentationTimeLine.map((s) => ({
                    ...toAttributes({ d: s.d, t: s.t }),
                  })),
                },
              },
            },
          },
        },
        UTCTiming: {
          ...toAttributes({
            schemeIdUri: "urn:mpeg:dash:utc:http-iso:2014",
            value: "https://time.akamai.com/?iso&ms",
          }),
        },
      },
    });
  }

  build() {
    this.root = this.create();
    return this.root.end({ prettyPrint: true });
  }
}

const toAttributes = (o: object) =>
  Object.entries(o).reduce((acc: any, [k, v]) => {
    acc["@" + k] = v;
    return acc;
  }, {});
