module.exports = [
  "api/index",
  "api/modules",
  {
    "type": "category",
    "label": "Enumerations",
    "items": [
      "api/enums/packetchunk",
      "api/enums/packetstatus"
    ]
  },
  {
    "type": "category",
    "label": "Classes",
    "items": [
      "api/classes/genericnack",
      "api/classes/mediastreamtrack",
      "api/classes/picturelossindication",
      "api/classes/promisequeue",
      "api/classes/rtccertificate",
      "api/classes/rtcdatachannel",
      "api/classes/rtcdtlstransport",
      "api/classes/rtcicegatherer",
      "api/classes/rtcicetransport",
      "api/classes/rtcpeerconnection",
      "api/classes/rtcrtpcodecparameters",
      "api/classes/rtcrtptransceiver",
      "api/classes/rtcsctptransport",
      "api/classes/rtcsessiondescription",
      "api/classes/receiverestimatedmaxbitrate",
      "api/classes/recvdelta",
      "api/classes/rtcpheader",
      "api/classes/rtcppacketconverter",
      "api/classes/rtcppayloadspecificfeedback",
      "api/classes/rtcpreceiverinfo",
      "api/classes/rtcprrpacket",
      "api/classes/rtcpsenderinfo",
      "api/classes/rtcpsourcedescriptionpacket",
      "api/classes/rtcpsrpacket",
      "api/classes/rtcptransportlayerfeedback",
      "api/classes/rtpheader",
      "api/classes/rtppacket",
      "api/classes/runlengthchunk",
      "api/classes/sourcedescriptionchunk",
      "api/classes/sourcedescriptionitem",
      "api/classes/srtcpsession",
      "api/classes/srtpsession",
      "api/classes/statusvectorchunk",
      "api/classes/transportwidecc"
    ]
  },
  {
    "type": "category",
    "label": "Interfaces",
    "items": [
      "api/interfaces/transceiveroptions"
    ]
  }
];