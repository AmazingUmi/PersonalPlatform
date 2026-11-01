export function memoryCounters(stats) {
  const usage = stats.memory_stats?.usage;
  if (!Number.isFinite(usage)) throw new Error('Docker memory counter missing');
  const inactive = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.total_inactive_file ?? 0;
  return { rawBytes: usage, workingSetBytes: usage - (inactive < usage ? inactive : 0) };
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(samples, phases, requests) {
  const result = {};
  for (const phase of phases) {
    const intervals = [];
    for (let i = 1; i < samples.length; i++) {
      const before = samples[i - 1], after = samples[i];
      if (before.phase !== phase.name || after.phase !== phase.name) continue;
      const duration = (after.monotonicMs - before.monotonicMs) / 1000;
      if (!(duration > 0)) throw new Error('Non-increasing sample clock');
      const groups = {};
      for (const service of Object.keys(after.services)) {
        const a = after.services[service], b = before.services[service];
        if (!b || a.id !== b.id || a.cpuNanoseconds < b.cpuNanoseconds) throw new Error('Container restarted or CPU counter reset during measurement');
        groups[service] = { cpuSeconds: (a.cpuNanoseconds - b.cpuNanoseconds) / 1e9, ...a.memory };
      }
      groups.total = Object.fromEntries(['cpuSeconds', 'rawBytes', 'workingSetBytes'].map(key => [key, Object.values(groups).reduce((n, g) => n + g[key], 0)]));
      intervals.push({ duration, groups });
    }
    const reqs = requests.filter(r => r.phase === phase.name);
    const wallSeconds = (phase.endMs - phase.startMs) / 1000;
    const measuredSeconds = intervals.reduce((n, r) => n + r.duration, 0);
    // Per-work normalization uses requests completed within the same sampled window.
    const phaseSamples = samples.filter(s => s.phase === phase.name);
    const measuredRequests = phaseSamples.length < 2 ? [] : reqs.filter(r => r.monotonicMs > phaseSamples[0].monotonicMs && r.monotonicMs <= phaseSamples.at(-1).monotonicMs);
    const record = { durationSeconds: wallSeconds, measuredSeconds, sampleIntervals: intervals.length,
      requests: reqs.length, unexpectedResponses: reqs.filter(r => r.status !== r.expected).length,
      successfulRequests: reqs.filter(r => r.status < 400 && r.status === r.expected).length,
      requestsPerSecond: reqs.length / wallSeconds,
      p50Ms: percentile(reqs.map(r => r.ms), .5), p95Ms: percentile(reqs.map(r => r.ms), .95),
      completeCycles: phase.cycles ?? null, measuredSuccessfulRequests: measuredRequests.filter(r => r.status < 400 && r.status === r.expected).length, services: {} };
    for (const service of ['database', 'backend', 'frontend', 'total']) {
      if (!intervals.length) continue;
      const cpuSeconds = intervals.reduce((n, r) => n + r.groups[service].cpuSeconds, 0);
      const g = { cpuSeconds, cpuMeanPercent: cpuSeconds / measuredSeconds * 100,
        cpuPeakPercent: Math.max(...intervals.map(r => r.groups[service].cpuSeconds / r.duration * 100)),
        cpuSecondsPerSuccessfulRequest: record.measuredSuccessfulRequests ? cpuSeconds / record.measuredSuccessfulRequests : null };
      for (const key of ['rawBytes', 'workingSetBytes']) {
        g[key + 'Median'] = percentile(intervals.map(r => r.groups[service][key]), .5);
        g[key + 'Peak'] = Math.max(...intervals.map(r => r.groups[service][key]));
      }
      record.services[service] = g;
    }
    result[phase.name] = record;
  }
  return result;
}
