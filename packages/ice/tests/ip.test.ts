import ip from "../src/ip";

describe('IP library for node.js', () => {
  describe('toBuffer()/toString() methods', () => {
    it('should convert to buffer IPv4 address', () => {
      const buf = ip.toBuffer('127.0.0.1');
      assert.equal(buf.toString('hex'), '7f000001');
      assert.equal(ip.toString(buf), '127.0.0.1');
    });


    it('should convert to buffer IPv6 address', () => {
      const buf = ip.toBuffer('::1');
      assert(/(00){15,15}01/.test(buf.toString('hex')));
      assert.equal(ip.toString(buf), '::1');
      assert.equal(ip.toString(ip.toBuffer('1::')), '1::');
      assert.equal(ip.toString(ip.toBuffer('abcd::dcba')), 'abcd::dcba');
    });

    it('should convert to buffer IPv6 mapped IPv4 address', () => {
      let buf = ip.toBuffer('::ffff:127.0.0.1');
      assert.equal(buf.toString('hex'), '00000000000000000000ffff7f000001');
      assert.equal(ip.toString(buf), '::ffff:7f00:1');

      buf = ip.toBuffer('ffff::127.0.0.1');
      assert.equal(buf.toString('hex'), 'ffff000000000000000000007f000001');
      assert.equal(ip.toString(buf), 'ffff::7f00:1');

      buf = ip.toBuffer('0:0:0:0:0:ffff:127.0.0.1');
      assert.equal(buf.toString('hex'), '00000000000000000000ffff7f000001');
      assert.equal(ip.toString(buf), '::ffff:7f00:1');
    });
  });

  describe('isLoopback() method', () => {
    describe('127.0.0.1', () => {
      it('should respond with true', () => {
        assert.ok(ip.isLoopback('127.0.0.1'));
      });
    });

    describe('127.8.8.8', () => {
      it('should respond with true', () => {
        assert.ok(ip.isLoopback('127.8.8.8'));
      });
    });

    describe('8.8.8.8', () => {
      it('should respond with false', () => {
        assert.equal(ip.isLoopback('8.8.8.8'), false);
      });
    });

    describe('fe80::1', () => {
      it('should respond with true', () => {
        assert.ok(ip.isLoopback('fe80::1'));
      });
    });

    describe('::1', () => {
      it('should respond with true', () => {
        assert.ok(ip.isLoopback('::1'));
      });
    });

    describe('::', () => {
      it('should respond with true', () => {
        assert.ok(ip.isLoopback('::'));
      });
    });
  });

  describe('fromLong() method', () => {
    it('should respond with ipv4 address', () => {
      assert.equal(ip.fromLong(2130706433), '127.0.0.1');
      assert.equal(ip.fromLong(4294967295), '255.255.255.255');
    });
  });

  // IPv4 loopback in octal notation
  it('should return true for octal representation "0177.0.0.1"', () => {
    assert.equal(ip.isLoopback('0177.0.0.1'), true);
  });

  it('should return true for octal representation "0177.0.1"', () => {
    assert.equal(ip.isLoopback('0177.0.1'), true);
  });

  it('should return true for octal representation "0177.1"', () => {
    assert.equal(ip.isLoopback('0177.1'), true);
  });

  // IPv4 loopback in hexadecimal notation
  it('should return true for hexadecimal representation "0x7f.0.0.1"', () => {
    assert.equal(ip.isLoopback('0x7f.0.0.1'), true);
  });

  // IPv4 loopback in hexadecimal notation
  it('should return true for hexadecimal representation "0x7f.0.1"', () => {
    assert.equal(ip.isLoopback('0x7f.0.1'), true);
  });

  // IPv4 loopback in hexadecimal notation
  it('should return true for hexadecimal representation "0x7f.1"', () => {
    assert.equal(ip.isLoopback('0x7f.1'), true);
  });

  // IPv4 loopback as a single long integer
  it('should return true for single long integer representation "2130706433"', () => {
    assert.equal(ip.isLoopback('2130706433'), true);
  });

  // IPv4 non-loopback address
  it('should return false for "192.168.1.1"', () => {
    assert.equal(ip.isLoopback('192.168.1.1'), false);
  });
});