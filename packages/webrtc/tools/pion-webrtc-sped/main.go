// Pion PeerConnection with SPED (pion/webrtc#3362) driven over JSON lines on
// stdin / stdout, for werift's opt-in SPED interop test
// (packages/webrtc/tests/integrate/sped-pion-webrtc.test.ts).
//
// stdin:
//
//	{"cmd":"offer"}                    create a data channel "pion" and an offer
//	{"cmd":"answer","sdp":"..."}       apply werift's answer (after "offer")
//	{"cmd":"remoteOffer","sdp":"..."}  apply werift's offer and answer it
//	{"cmd":"send","label":"...","data":"..."}
//	{"cmd":"close"}
//
// stdout: {"event":"sdp","type":"offer|answer","sdp":"..."} (ICE gathering
// complete, no trickle), {"event":"open","label":"..."},
// {"event":"message","label":"...","data":"..."},
// {"event":"state","state":"..."}, {"event":"dtls","version":"..."},
// {"event":"error","message":"..."}. Every received message is echoed back
// as "echo:" + data on the same channel.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"

	"github.com/pion/webrtc/v5"
)

type command struct {
	Cmd   string `json:"cmd"`
	SDP   string `json:"sdp,omitempty"`
	Label string `json:"label,omitempty"`
	Data  string `json:"data,omitempty"`
}

var (
	outMu    sync.Mutex
	channels sync.Map
)

func emit(v map[string]string) {
	outMu.Lock()
	defer outMu.Unlock()
	b, _ := json.Marshal(v)
	os.Stdout.Write(append(b, '\n'))
}

func fail(err error) {
	emit(map[string]string{"event": "error", "message": err.Error()})
}

func watch(dc *webrtc.DataChannel) {
	channels.Store(dc.Label(), dc)
	dc.OnOpen(func() { emit(map[string]string{"event": "open", "label": dc.Label()}) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		data := string(msg.Data)
		emit(map[string]string{"event": "message", "label": dc.Label(), "data": data})
		if len(data) < 5 || data[:5] != "echo:" {
			if err := dc.SendText("echo:" + data); err != nil {
				fail(err)
			}
		}
	})
}

func sendLocal(pc *webrtc.PeerConnection, desc webrtc.SessionDescription) {
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(desc); err != nil {
		fail(err)
		return
	}
	<-gathered
	local := pc.LocalDescription()
	emit(map[string]string{"event": "sdp", "type": local.Type.String(), "sdp": local.SDP})
}

func main() {
	s := webrtc.SettingEngine{}
	s.EnableSped(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(s))
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		BundlePolicy: webrtc.BundlePolicyMaxBundle,
	})
	if err != nil {
		fail(err)
		os.Exit(1)
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		emit(map[string]string{"event": "state", "state": state.String()})
		if state == webrtc.PeerConnectionStateConnected {
			if sctp := pc.SCTP(); sctp != nil {
				if dtls := sctp.Transport(); dtls != nil {
					emit(map[string]string{"event": "dtls", "state": dtls.State().String()})
				}
			}
		}
	})
	pc.OnDataChannel(watch)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var c command
		if err := json.Unmarshal(scanner.Bytes(), &c); err != nil {
			fail(err)
			continue
		}
		switch c.Cmd {
		case "offer":
			dc, err := pc.CreateDataChannel("pion", nil)
			if err != nil {
				fail(err)
				continue
			}
			watch(dc)
			offer, err := pc.CreateOffer(nil)
			if err != nil {
				fail(err)
				continue
			}
			sendLocal(pc, offer)
		case "answer":
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: c.SDP}); err != nil {
				fail(err)
			}
		case "remoteOffer":
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: c.SDP}); err != nil {
				fail(err)
				continue
			}
			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				fail(err)
				continue
			}
			sendLocal(pc, answer)
		case "send":
			if v, ok := channels.Load(c.Label); ok {
				if err := v.(*webrtc.DataChannel).SendText(c.Data); err != nil {
					fail(err)
				}
			} else {
				emit(map[string]string{"event": "error", "message": "no channel " + c.Label})
			}
		case "close":
			_ = pc.Close()
			return
		}
	}
	_ = pc.Close()
}
