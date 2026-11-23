#!/usr/bin/env node
import { pullMain } from './pull.js';
process.exitCode = await pullMain(process.argv.slice(2));
