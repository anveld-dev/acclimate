#!/usr/bin/env node
import { applicationMain } from './app-cli.js';

process.exitCode = await applicationMain();
