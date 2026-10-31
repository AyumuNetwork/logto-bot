#!/usr/bin/env node
/**
 * Thin wrapper so `pnpm ws-relay` works in development.
 * The implementation lives in `src/relayMain.ts` (shipped as dist/relayMain.js).
 */
import { runRelay } from '../src/relayMain.js';

await runRelay();
