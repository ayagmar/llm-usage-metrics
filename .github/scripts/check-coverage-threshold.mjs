import { readFileSync } from 'node:fs';
import path from 'node:path';

const inputPath = 'coverage/coverage-summary.json';

const minimumCoveragePercent = {
  lines: 90,
  statements: 90,
  functions: 95,
  branches: 85,
};

const minimumFileCoveragePercent = {
  lines: 80,
  statements: 80,
  functions: 75,
  branches: 70,
};

const coverageSummary = JSON.parse(readFileSync(inputPath, 'utf8'));
const totals = coverageSummary.total;

if (!totals) {
  throw new Error(`Could not find total coverage metrics in ${inputPath}`);
}

function getFailedMetrics(coverageMetrics, minimums) {
  return Object.entries(minimums).flatMap(([metric, minimum]) => {
    const actual = coverageMetrics[metric]?.pct;

    if (typeof actual !== 'number') {
      throw new Error(`Could not find coverage metric "${metric}" in ${inputPath}`);
    }

    if (actual >= minimum) {
      return [];
    }

    return [`${metric}: ${actual.toFixed(2)}% < ${minimum.toFixed(2)}%`];
  });
}

const failedMetrics = getFailedMetrics(totals, minimumCoveragePercent);

const fileFailures = Object.entries(coverageSummary).flatMap(([filePath, fileCoverage]) => {
  if (filePath === 'total' || fileCoverage.statements?.total === 0) {
    return [];
  }

  const failedFileMetrics = getFailedMetrics(fileCoverage, minimumFileCoveragePercent);

  if (failedFileMetrics.length === 0) {
    return [];
  }

  return [`${path.relative(process.cwd(), filePath)}:\n${failedFileMetrics.join('\n')}`];
});

if (failedMetrics.length > 0) {
  throw new Error(
    `Coverage threshold check failed:\n${failedMetrics.map((item) => `- ${item}`).join('\n')}`,
  );
}

if (fileFailures.length > 0) {
  throw new Error(
    `Per-file coverage threshold check failed:\n${fileFailures
      .map((item) => `- ${item}`)
      .join('\n')}`,
  );
}
