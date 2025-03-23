# Werift WebRTC Development Guide

## Build/Test Commands
- Build all packages: `npm run build`
- Type check: `npm run type`
- Format code: `npm run format`
- Lint: Check biome.json for rules (using @biomejs/biome)
- Run all tests: `npm run test`
- Run tests for specific package: `cd packages/[package] && npx vitest`
- Run single test: `cd packages/[package] && npx vitest [test-file-path] -t "[test description]"`
- Debug with verbose logging: `DEBUG=werift* npx tsx watch [file-path]`

## Code Style Guidelines
- TypeScript with strict mode and strict null checks
- Space indentation (see biome.json)
- Imports: Use Node.js style imports (CommonJS)
- Error handling: Throw specific error types extending from WeriftError
- Naming: camelCase for variables/functions, PascalCase for classes/types
- Types: Explicit typing for function parameters and returns
- Testing: Use vitest with describe/test blocks and expect assertions
- Documentation: JSDoc for public APIs

## Project Structure
- Modular monorepo with packages for: webrtc, rtp, dtls, ice, sctp, common
- Tests in packages/*/tests directories
- Examples in examples/ directory