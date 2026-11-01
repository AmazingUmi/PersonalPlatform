import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryCounters, summarize } from '../benchmark-runtime/metrics.mjs';

test('working set uses the cgroup v2/v1 inactive counter without subtracting all cache or shared RSS', () => {
  assert.deepEqual(memoryCounters({ memory_stats: { usage: 100, stats: { inactive_file: 30, file: 50 } } }), { rawBytes: 100, workingSetBytes: 70 });
  assert.deepEqual(memoryCounters({ memory_stats: { usage: 100, stats: { total_inactive_file: 20 } } }), { rawBytes: 100, workingSetBytes: 80 });
  assert.deepEqual(memoryCounters({ memory_stats: { usage: 100, stats: { inactive_file: 120 } } }), { rawBytes: 100, workingSetBytes: 100 });
  assert.throws(() => memoryCounters({}), /missing/);
});

const service = (cpu, memory) => ({ id: 'same', cpuNanoseconds: cpu * 1e9, memory: { rawBytes: memory, workingSetBytes: memory / 2 } });
const sample = (time, phase, cpu) => ({ monotonicMs: time, phase, services: { backend: service(cpu, 100), database: service(cpu / 2, 80), frontend: service(cpu / 4, 20) } });
test('CPU uses cumulative deltas, real elapsed time, excludes boundaries, and normalizes work over the sampled window', () => {
  const samples = [sample(0, 'setup', 10), sample(1000, 'load', 11), sample(3000, 'load', 12), sample(4000, 'other', 14)];
  const requests = [{ phase: 'load', monotonicMs: 500, status: 200, expected: 200, ms: 1 }, { phase: 'load', monotonicMs: 2000, status: 200, expected: 200, ms: 5 }, { phase: 'load', monotonicMs: 2500, status: 404, expected: 404, ms: 6 }];
  const result = summarize(samples, [{ name: 'load', startMs: 400, endMs: 3500 }], requests).load;
  assert.equal(result.services.backend.cpuMeanPercent, 50);
  assert.equal(result.services.total.cpuMeanPercent, 87.5);
  assert.equal(result.services.total.cpuSecondsPerSuccessfulRequest, 1.75);
  assert.equal(result.measuredSuccessfulRequests, 1);
  assert.equal(result.unexpectedResponses, 0);
  assert.equal(result.services.total.workingSetBytesMedian, 100);
});
test('a reset counter fails measurement rather than hiding a service restart', () => {
  assert.throws(() => summarize([sample(0, 'load', 10), sample(1000, 'load', 1)], [{ name: 'load', startMs: 0, endMs: 1000 }], []), /reset/);
});
