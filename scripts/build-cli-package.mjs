#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(REPO_ROOT, 'distribution.json');
const target = join(REPO_ROOT, 'packages', 'cli', 'dist', 'manager', 'distribution.json');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
