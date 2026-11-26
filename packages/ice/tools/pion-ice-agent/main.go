package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
)

type line struct {
	Type      string `json:"type"`
	Ufrag     string `json:"ufrag,omitempty"`
	Pwd       string `json:"pwd,omitempty"`
	Candidate string `json:"candidate,omitempty"`
	Data      string `json:"data,omitempty"`
	Error     string `json:"error,omitempty"`
}

func main() {
	if err := run(); err != nil {
		emit(line{Type: "error", Error: err.Error()})
		os.Exit(1)
	}
}

func run() error {
	controlling := false
	for _, arg := range os.Args[1:] {
		if arg == "-controlling" {
			controlling = true
		}
	}

	agent, err := ice.NewAgent(&ice.AgentConfig{
		NetworkTypes:    []ice.NetworkType{ice.NetworkTypeUDP4},
		IncludeLoopback: true,
	})
	if err != nil {
		return err
	}
	defer agent.Close()

	ufrag, pwd, err := agent.GetLocalUserCredentials()
	if err != nil {
		return err
	}
	emit(line{Type: "local-auth", Ufrag: ufrag, Pwd: pwd})

	if err := agent.OnCandidate(func(c ice.Candidate) {
		if c == nil {
			emit(line{Type: "gathering-complete"})
			return
		}
		emit(line{Type: "candidate", Candidate: c.Marshal()})
	}); err != nil {
		return err
	}

	if err := agent.GatherCandidates(); err != nil {
		return err
	}

	var (
		mu      sync.Mutex
		conn    *ice.Conn
		pending [][]byte
	)

	writeDatagram := func(payload []byte) error {
		mu.Lock()
		c := conn
		if c == nil {
			pending = append(pending, append([]byte(nil), payload...))
			mu.Unlock()
			return nil
		}
		mu.Unlock()
		_, err := c.Write(payload)
		return err
	}

	start := func(remoteUfrag, remotePwd string) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		var (
			c   *ice.Conn
			err error
		)
		if controlling {
			c, err = agent.Dial(ctx, remoteUfrag, remotePwd)
		} else {
			c, err = agent.Accept(ctx, remoteUfrag, remotePwd)
		}
		if err != nil {
			emit(line{Type: "error", Error: err.Error()})
			return
		}
		mu.Lock()
		conn = c
		queued := pending
		pending = nil
		mu.Unlock()
		for _, payload := range queued {
			if _, err := c.Write(payload); err != nil {
				emit(line{Type: "error", Error: err.Error()})
				return
			}
		}
		emit(line{Type: "connected"})
		buf := make([]byte, 64*1024)
		for {
			n, err := c.Read(buf)
			if err != nil {
				if err != io.EOF {
					emit(line{Type: "error", Error: err.Error()})
				}
				return
			}
			emit(line{Type: "datagram", Data: hex.EncodeToString(buf[:n])})
		}
	}

	var remoteUfrag, remotePwd string
	started := false
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		var msg line
		if err := json.Unmarshal([]byte(text), &msg); err != nil {
			return err
		}
		switch msg.Type {
		case "remote-auth":
			remoteUfrag = msg.Ufrag
			remotePwd = msg.Pwd
		case "candidate":
			cand, err := ice.UnmarshalCandidate(strings.TrimPrefix(msg.Candidate, "candidate:"))
			if err != nil {
				return fmt.Errorf("candidate: %w", err)
			}
			if err := agent.AddRemoteCandidate(cand); err != nil {
				return err
			}
		case "end-of-candidates":
			if started || remoteUfrag == "" || remotePwd == "" {
				continue
			}
			started = true
			go start(remoteUfrag, remotePwd)
		case "datagram":
			payload, err := hex.DecodeString(msg.Data)
			if err != nil {
				return err
			}
			if err := writeDatagram(payload); err != nil {
				return err
			}
		case "close":
			return nil
		default:
			return fmt.Errorf("unknown type %q", msg.Type)
		}
	}
	return scanner.Err()
}

var emitMu sync.Mutex

func emit(v line) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	emitMu.Lock()
	defer emitMu.Unlock()
	fmt.Println(string(b))
}
