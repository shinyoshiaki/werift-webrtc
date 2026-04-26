# Changelog

## v0.22.3

### 🚀 Features & Improvements

- **WebM/VINT**: Implement VINT encoding/decoding functions and add tests
- **Transport**: Add `closed` property to transport classes and improve close methods
- **Exports**: Export `stats` module from `media/index.ts`
- **Performance/Refactor**:
    - Remove `lodash` dependency (replaced with native functions or lighter alternatives)
    - Remove `nano-time`, `date-fns`, `uuid` dependencies
    - Use `structuredClone` instead of `lodash/cloneDeep`
    - Replace `lodash/isEqual` with `fast-deep-equal`

### 🐛 Bug Fixes

- **Circular Dependencies**: Fix circular reference/imports in `RtcpTransportLayerFeedback` and `RtcpPacketConverter`
- **Connection**: Various connection state fixes per RFC
- **DataChannel**: Fix issues with reconfig stream on fast data channel close
- **Bundle**: Use bundle for `addTransceiver` in bundle max-compat if remote is bundled
- **Typing**: Fix uuid typing

### 📦 Dependency Updates

- Bump `undici`, `express`, `zx`, `vite`, `axios`, `form-data` and others in examples/e2e.
