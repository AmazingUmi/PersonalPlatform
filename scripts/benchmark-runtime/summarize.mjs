#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { summarize } from './metrics.mjs';
const output = resolve(process.argv[2] ?? '.');
const lines = name => readFileSync(join(output, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result = summarize(lines('samples.jsonl'), JSON.parse(readFileSync(join(output, 'phases.json'), 'utf8')), lines('requests.jsonl'));
writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
for (const [phase, data] of Object.entries(result)) console.log(phase, JSON.stringify({ requests: data.requests, unexpected: data.unexpectedResponses, rps: data.requestsPerSecond, p95Ms: data.p95Ms, total: data.services.total }));
