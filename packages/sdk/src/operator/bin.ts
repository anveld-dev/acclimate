#!/usr/bin/env node
import { operatorMain } from './cli.js';

process.exitCode = await operatorMain(process.argv.slice(2));
