#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

await rm(join(process.cwd(), 'dist'), { recursive: true, force: true });
