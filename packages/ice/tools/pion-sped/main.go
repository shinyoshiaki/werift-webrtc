package main

import (
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/pion/ice/v4"
	"github.com/pion/stun/v3"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println("pion-sped")
		fmt.Println("  AttrDtlsInStun    = 0xC070")
		fmt.Println("  AttrDtlsInStunAck = 0xC071")
		fmt.Println("  features = verify,empty-ack,sped-getfrom")
	case "check":
		if err := checkRoundTrip(); err != nil {
			fmt.Fprintf(os.Stderr, "check failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("pion-sped check OK")
		fmt.Println("  AttrDtlsInStun    = 0xC070 (DTLS-IN-STUN)")
		fmt.Println("  AttrDtlsInStunAck = 0xC071 (DTLS-IN-STUN-ACKNOWLEDGEMENT)")
	case "encode":
		fs := flag.NewFlagSet("encode", flag.ExitOnError)
		data := fs.String("data", "", "hex payload for DTLS-IN-STUN-DATA (omit flag to skip DATA)")
		ack := fs.String("ack", "", "comma-separated 8-hex-digit CRC32 values for DTLS-IN-STUN-ACK")
		emptyAck := fs.Bool("empty-ack", false, "include a zero-length DTLS-IN-STUN-ACK")
		integrityKey := fs.String("integrity-key", "", "short-term password for MESSAGE-INTEGRITY")
		_ = fs.Parse(os.Args[2:])
		if err := encode(*data, *ack, *emptyAck, *integrityKey, fs); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "decode":
		if len(os.Args) < 3 {
			usage()
			os.Exit(2)
		}
		if err := decode(os.Args[2]); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "verify":
		fs := flag.NewFlagSet("verify", flag.ExitOnError)
		integrityKey := fs.String("integrity-key", "", "short-term password for MESSAGE-INTEGRITY")
		_ = fs.Parse(os.Args[2:])
		args := fs.Args()
		if *integrityKey == "" || len(args) < 1 {
			usage()
			os.Exit(2)
		}
		if err := verify(*integrityKey, args[0]); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("MESSAGE-INTEGRITY OK")
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `Usage:
  pion-sped check
  pion-sped encode [-data hex] [-ack crc32hex,crc32hex,...] [-empty-ack] [-integrity-key password]
  pion-sped decode <stun-message-hex>
  pion-sped verify -integrity-key password <stun-message-hex>
  pion-sped version
  decode uses pion/ice sped.go GetFrom (sped-getfrom)
`)
}

func checkRoundTrip() error {
	msg, err := stun.Build(
		stun.TransactionID,
		stun.BindingRequest,
		ice.DtlsInStunAttribute(nil),
		ice.DtlsInStunAckAttribute(nil),
	)
	if err != nil {
		return err
	}
	parsed := &stun.Message{Raw: msg.Raw}
	if err := parsed.Decode(); err != nil {
		return err
	}
	var data ice.DtlsInStunAttribute
	if err := data.GetFrom(parsed); err != nil {
		return fmt.Errorf("DtlsInStunAttribute.GetFrom: %w", err)
	}
	var ack ice.DtlsInStunAckAttribute
	if err := ack.GetFrom(parsed); err != nil {
		return fmt.Errorf("DtlsInStunAckAttribute.GetFrom: %w", err)
	}
	fmt.Printf("  round-trip stun bytes = %d\n", len(msg.Raw))
	return nil
}

func encode(dataHex, ackCSV string, emptyAck bool, integrityKey string, fs *flag.FlagSet) error {
	var attrs []stun.Setter
	attrs = append(attrs, stun.TransactionID, stun.BindingRequest)

	dataProvided := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "data" {
			dataProvided = true
		}
	})
	if dataProvided {
		dataValue, err := hex.DecodeString(dataHex)
		if err != nil {
			return fmt.Errorf("data: %w", err)
		}
		attrs = append(attrs, ice.DtlsInStunAttribute(dataValue))
	}

	if emptyAck {
		attrs = append(attrs, ice.DtlsInStunAckAttribute(nil))
	} else if ackCSV != "" {
		parts := strings.Split(ackCSV, ",")
		crcs := make([]uint32, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			b, err := hex.DecodeString(part)
			if err != nil || len(b) != 4 {
				return fmt.Errorf("ack %q must be 8 hex digits", part)
			}
			crcs = append(crcs, uint32(b[0])<<24|uint32(b[1])<<16|uint32(b[2])<<8|uint32(b[3]))
		}
		if len(crcs) > 0 {
			attrs = append(attrs, ice.DtlsInStunAckAttribute(crcs))
		}
	}

	if integrityKey != "" {
		attrs = append(attrs, stun.NewShortTermIntegrity(integrityKey))
		attrs = append(attrs, stun.Fingerprint)
	}

	msg, err := stun.Build(attrs...)
	if err != nil {
		return err
	}
	fmt.Println(hex.EncodeToString(msg.Raw))
	return nil
}

func decode(messageHex string) error {
	buf, err := hex.DecodeString(messageHex)
	if err != nil {
		return err
	}
	msg := &stun.Message{Raw: buf}
	if err := msg.Decode(); err != nil {
		return err
	}
	fmt.Printf("message type = %s\n", msg.Type)
	fmt.Printf("transaction  = %s\n", hex.EncodeToString(msg.TransactionID[:]))
	for _, raw := range msg.Attributes {
		name := raw.Type.String()
		fmt.Printf("  attr type=0x%04X name=%s len=%d value=%s\n",
			uint16(raw.Type), name, len(raw.Value), hex.EncodeToString(raw.Value))
	}
	return decodeSpedGetFrom(msg)
}

func decodeSpedGetFrom(msg *stun.Message) error {
	var data ice.DtlsInStunAttribute
	if err := data.GetFrom(msg); err != nil {
		if !errors.Is(err, stun.ErrAttributeNotFound) {
			return fmt.Errorf("DtlsInStunAttribute.GetFrom: %w", err)
		}
	} else {
		fmt.Printf("  DtlsInStunAttribute.GetFrom value=%s len=%d\n",
			hex.EncodeToString(data), len(data))
	}

	var ack ice.DtlsInStunAckAttribute
	if err := ack.GetFrom(msg); err != nil {
		if !errors.Is(err, stun.ErrAttributeNotFound) {
			return fmt.Errorf("DtlsInStunAckAttribute.GetFrom: %w", err)
		}
	} else {
		parts := make([]string, len(ack))
		for i, crc := range ack {
			parts[i] = fmt.Sprintf("%08x", crc)
		}
		fmt.Printf("  DtlsInStunAckAttribute.GetFrom crcs=%s count=%d\n",
			strings.Join(parts, ","), len(ack))
	}
	return nil
}

func verify(integrityKey, messageHex string) error {
	buf, err := hex.DecodeString(messageHex)
	if err != nil {
		return err
	}
	msg := &stun.Message{Raw: buf}
	if err := msg.Decode(); err != nil {
		return err
	}
	return stun.NewShortTermIntegrity(integrityKey).Check(msg)
}
