#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from './config.js';
import { loadCorpus } from './corpus/loader.js';
import { buildCoverageMatrix } from './corpus/coverage.js';
import { VALID_SEVERITIES } from './corpus/schema.js';
import { createAdapter } from './adapters/index.js';
import { expandGlobs } from './util/glob.js';
import { runProbe } from './runner.js';
import { scoreResults, summarize } from './scoring/index.js';
import { createJudge } from './scoring/judge.js';
import { buildResultFile, writeJsonReport, makeRunId, defaultResultsPath } from './report/json.js';
import { writeHtmlReport, defaultReportPath } from './report/html.js';
import { diffResults, sortDiffEntries, hasRegressions } from './util/diff.js';
import { createLogger } from './util/logger.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const STATUS_COLOR = { pass: pc.green, fail: pc.red, error: pc.yellow };
const SEVERITY_COLOR = { critical: pc.red, high: pc.red, medium: pc.yellow, low: pc.dim };

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const SCOPE_BANNER =
  `${pc.bold('llm-guard-probe')} tests systems you own or have written permission to test.\n` +
  'Do not point it at third-party production systems without authorization.\n';

// Variadic so a shell-expanded "--corpus corpus/*.yaml" (bash expands the
// glob itself before we ever see it) is captured in full, not just its
// first match; still supports our own glob expansion when the pattern
// arrives unexpanded (e.g. quoted, or on shells that don't glob).
function collectVariadic(value, previous) {
  return [...previous, value];
}

function printResultsTable(scoredResults) {
  const idWidth = Math.max(2, ...scoredResults.map((r) => r.payloadId.length));
  console.log(`${'ID'.padEnd(idWidth)}  ${'STATUS'.padEnd(5)}  ${'MS'.padEnd(6)}  RESPONSE`);

  for (const r of scoredResults) {
    const color = STATUS_COLOR[r.status] ?? ((s) => s);
    const status = color(r.status.padEnd(5));
    const ms = String(r.latencyMs ?? '-').padEnd(6);
    const snippet = (r.transportError ? r.transportError.message : (r.response ?? '')).replace(/\s+/g, ' ').slice(0, 80);
    console.log(`${r.payloadId.padEnd(idWidth)}  ${status}  ${ms}  ${snippet}`);
  }
}

function printSummary(summary) {
  const rateColor = summary.failed > 0 ? pc.red : summary.errored > 0 ? pc.yellow : pc.green;
  console.log(
    `\n${pc.bold('Pass rate:')} ${rateColor(`${(summary.passRate * 100).toFixed(1)}%`)}  ` +
      `(${pc.green(`${summary.passed} passed`)}, ${pc.red(`${summary.failed} failed`)}, ${pc.yellow(`${summary.errored} errored`)}, ${summary.total} total)\n`,
  );

  console.log(pc.bold('By category:'));
  const categories = Object.keys(summary.byCategory).sort();
  const catWidth = Math.max(8, ...categories.map((c) => c.length));
  for (const category of categories) {
    const c = summary.byCategory[category];
    const rate = `${(c.passRate * 100).toFixed(0)}%`.padStart(4);
    const color = c.failed > 0 ? pc.red : c.errored > 0 ? pc.yellow : pc.green;
    console.log(`  ${category.padEnd(catWidth)}  ${color(rate)}  (${c.passed}/${c.total} passed)`);
  }
}

function printFailures(scoredResults) {
  const failures = scoredResults
    .filter((r) => r.status === 'fail')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  if (failures.length === 0) return;

  console.log(`\n${pc.bold(pc.red(`Failures (${failures.length}):`))}`);
  for (const r of failures) {
    const severity = (SEVERITY_COLOR[r.severity] ?? ((s) => s))(r.severity.toUpperCase());
    console.log(`\n  ${pc.bold(r.payloadId)} ${pc.dim(`[${r.category}]`)} ${severity} — ${r.name}`);
    for (const rule of r.rules) {
      if (rule.passed === false) console.log(`    ${pc.red('✖')} ${rule.rule}: ${rule.evidence}`);
    }
  }
  console.log();
}

function printCoverageMatrix({ categories, total, totalBySeverity }) {
  const severityHeaders = VALID_SEVERITIES.map((s) => s.toUpperCase());
  const catWidth = Math.max(8, ...categories.map((c) => c.category.length), 'TOTAL'.length);
  const colWidth = Math.max(5, ...severityHeaders.map((h) => h.length));

  const row = (label, rowTotal, cells) =>
    `${label.padEnd(catWidth)}  ${String(rowTotal).padStart(5)}  ${cells.map((c) => String(c).padStart(colWidth)).join('  ')}`;

  console.log(row('CATEGORY', 'TOTAL', severityHeaders));
  for (const c of categories) {
    console.log(row(c.category, c.total, VALID_SEVERITIES.map((s) => c.bySeverity[s])));
  }
  console.log(row('TOTAL', total, VALID_SEVERITIES.map((s) => totalBySeverity[s])));
}

const DIFF_HEADLINE = { regressed: 'regressed', fixed: 'fixed', changed: 'changed', new: 'new', removed: 'removed' };

async function readResultFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function printDiffSummary(diff) {
  const { summary } = diff;
  const regColor = summary.regressed > 0 ? pc.red : (s) => s;
  console.log(
    `\n${pc.bold('Changes since baseline:')} ${regColor(`${summary.regressed} regressed`)}, ` +
      `${pc.green(`${summary.fixed} fixed`)}, ${summary.changed} changed, ${summary.new} new, ` +
      `${summary.removed} removed, ${summary.unchanged} unchanged\n`,
  );

  const notable = sortDiffEntries(diff.entries.filter((e) => e.classification !== 'unchanged'));
  if (notable.length === 0) {
    console.log(pc.dim('  (no changes since baseline)\n'));
    return;
  }

  for (const e of notable) {
    const label = DIFF_HEADLINE[e.classification] ?? e.classification;
    const color = e.classification === 'regressed' ? pc.red : e.classification === 'fixed' ? pc.green : pc.yellow;
    const arrow = `${e.before ?? '—'} → ${e.after ?? '—'}`;
    console.log(`  ${color(label.padEnd(9))} ${pc.bold(e.payloadId)} ${pc.dim(`[${e.category}]`)} ${e.severity ?? ''}  ${arrow}  — ${e.name ?? ''}`);
  }
  console.log();
}

const program = new Command();

program.name('llm-guard-probe').description(pkg.description).version(pkg.version);

program
  .command('run')
  .description('Run a corpus against a target, score the responses, and write a result file')
  .requiredOption('--config <path>', 'path to target config YAML')
  .option('--corpus <glob...>', 'corpus file(s) or glob pattern(s), repeatable', collectVariadic, [])
  .option('--out <path>', 'write the result JSON to this path (default: results/<runId>.json)')
  .option('--report <path>', 'write the self-contained HTML report to this path (default: results/<runId>.html)')
  .option('--no-report', 'skip writing the HTML report')
  .option('--no-judge', 'disable the LLM-as-judge rule entirely; payloads with a judge rule are marked "error", not scored')
  .option('--judge-model <name>', 'model used to evaluate judge rules (default: $JUDGE_MODEL or a built-in default)')
  .option('--concurrency <n>', 'override run.concurrency from the config', (v) => Number.parseInt(v, 10))
  .option('--baseline <path>', 'path to a previous result JSON file; classifies each payload against it as fixed/regressed/unchanged/new/removed')
  .option('--fail-under <rate>', 'exit 1 if the overall pass rate falls below this threshold (0-1)', (v) => Number.parseFloat(v))
  .option('--fail-on-regression', 'exit 1 if any payload that previously passed now fails (requires --baseline)', false)
  .option('--demo', 'mark the HTML report as a demo report with a prominent banner (used for the published docs/index.html)', false)
  .option('--verbose', 'verbose logging', false)
  .option('--quiet', 'suppress non-error logging', false)
  .action(async (opts) => {
    const logger = createLogger({ quiet: opts.quiet, verbose: opts.verbose });
    if (!opts.quiet) process.stderr.write(`\n${SCOPE_BANNER}\n`);

    if (opts.corpus.length === 0) {
      logger.error('At least one --corpus glob is required.');
      process.exitCode = 2;
      return;
    }

    if (opts.failOnRegression && !opts.baseline) {
      logger.error('--fail-on-regression requires --baseline <path> (there is nothing to compare against otherwise).');
      process.exitCode = 2;
      return;
    }

    if (opts.failUnder !== undefined && (Number.isNaN(opts.failUnder) || opts.failUnder < 0 || opts.failUnder > 1)) {
      logger.error(`--fail-under must be a number between 0 and 1 (got "${opts.failUnder}").`);
      process.exitCode = 2;
      return;
    }

    try {
      const config = await loadConfig(opts.config);
      if (opts.concurrency && !Number.isNaN(opts.concurrency)) {
        config.run.concurrency = opts.concurrency;
      }

      const corpusFiles = await expandGlobs(opts.corpus);
      if (corpusFiles.length === 0) {
        logger.error(`No corpus files matched: ${opts.corpus.join(', ')}`);
        process.exitCode = 2;
        return;
      }

      const { payloads, corpusVersion } = await loadCorpus(corpusFiles);
      logger.info(`Loaded ${payloads.length} payload(s) from ${corpusFiles.length} file(s). corpus=${corpusVersion}`);
      logger.info(`Target: ${config.name} (adapter: ${config.adapter}). Canary: ${config.canary}`);

      const hasJudgeRules = payloads.some((p) => p.expect.some((r) => r.rule === 'judge'));
      let judge = null;
      let judgeSkipReason = null;
      if (opts.judge === false) {
        judgeSkipReason = '--no-judge was passed.';
        if (hasJudgeRules) logger.info(`Judging disabled: ${judgeSkipReason}`);
      } else if (hasJudgeRules) {
        try {
          judge = createJudge({ model: opts.judgeModel });
          logger.info(`Judge enabled: ${judge.model}`);
        } catch (err) {
          judgeSkipReason = err.message;
          logger.warn(`Judging was skipped: ${judgeSkipReason}`);
        }
      }

      const adapter = createAdapter(config);
      const startedAt = new Date();

      const results = await runProbe({
        adapter,
        config,
        payloads,
        onProgress: (done, total) => {
          if (!opts.quiet) process.stderr.write(`\rRunning payload ${done}/${total}...`);
        },
      });
      if (!opts.quiet) process.stderr.write('\n\n');

      const scoredResults = await scoreResults(results, payloads, config.canary, { judge, judgeSkipReason });
      const summary = summarize(scoredResults);

      printResultsTable(scoredResults);
      printSummary(summary);
      printFailures(scoredResults);

      const runId = makeRunId(startedAt);
      const outPath = opts.out ?? defaultResultsPath(runId);
      const resultFile = buildResultFile({
        runId,
        target: config.name,
        adapter: config.adapter,
        corpusVersion,
        canary: config.canary,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        summary,
        results: scoredResults,
        judgeModel: judge?.model ?? null,
        judgeSkipReason,
      });
      await writeJsonReport(outPath, resultFile);
      logger.success(`Wrote result file to ${outPath}`);

      let diff = null;
      if (opts.baseline) {
        try {
          const baselineFile = await readResultFile(opts.baseline);
          diff = diffResults(baselineFile, resultFile);
          printDiffSummary(diff);
        } catch (err) {
          if (opts.failOnRegression) {
            // --fail-on-regression exists to be a CI safety net; silently
            // skipping it because the baseline was unreadable would make
            // that gate meaningless without ever telling anyone.
            logger.error(`Could not read baseline at ${opts.baseline}: ${err.message}. Refusing to continue with --fail-on-regression set.`);
            process.exitCode = 2;
            return;
          }
          logger.warn(`Could not read baseline at ${opts.baseline}: ${err.message}. Continuing without a baseline diff.`);
        }
      }

      if (opts.report !== false) {
        const reportPath = typeof opts.report === 'string' ? opts.report : defaultReportPath(runId);
        await writeHtmlReport(reportPath, resultFile, { diff, demo: !!opts.demo });
        logger.success(`Wrote HTML report to ${reportPath}`);
      }

      if (summary.errored > 0) {
        logger.warn(
          `${summary.errored} payload(s) could not be scored (transport error, a rule that errored, or a judge rule that couldn't be evaluated — see status "error" above). They do not count as failures.`,
        );
      }

      const failureReasons = [];
      if (summary.failed > 0) failureReasons.push(`${summary.failed} payload(s) failed`);
      if (opts.failUnder !== undefined && summary.passRate < opts.failUnder) {
        logger.error(`Pass rate ${(summary.passRate * 100).toFixed(1)}% is below --fail-under threshold ${(opts.failUnder * 100).toFixed(1)}%.`);
        failureReasons.push('pass rate below --fail-under threshold');
      }
      if (opts.failOnRegression && diff && hasRegressions(diff)) {
        logger.error(`${diff.summary.regressed} payload(s) regressed since baseline (previously passing, now failing).`);
        failureReasons.push(`${diff.summary.regressed} regression(s) since baseline`);
      }

      // Errored payloads are surfaced above but never turn a clean run red
      // on their own, per CLAUDE.md standing rule 5 (fail and error are
      // never conflated).
      process.exitCode = failureReasons.length > 0 ? 1 : 0;
    } catch (err) {
      logger.error(err.message);
      process.exitCode = 2;
    }
  });

program
  .command('list')
  .description('Load a corpus and print its coverage matrix by category and severity')
  .option('--corpus <glob...>', 'corpus file(s) or glob pattern(s), repeatable', collectVariadic, ['corpus/*.yaml'])
  .action(async (opts) => {
    const logger = createLogger({});
    try {
      const corpusFiles = await expandGlobs(opts.corpus);
      if (corpusFiles.length === 0) {
        logger.error(`No corpus files matched: ${opts.corpus.join(', ')}`);
        process.exitCode = 2;
        return;
      }

      const { payloads, corpusVersion } = await loadCorpus(corpusFiles);
      logger.info(`Loaded ${payloads.length} payload(s) from ${corpusFiles.length} file(s). corpus=${corpusVersion}\n`);

      printCoverageMatrix(buildCoverageMatrix(payloads));
    } catch (err) {
      logger.error(err.message);
      process.exitCode = 2;
    }
  });

program
  .command('diff')
  .description('Compare two result files and classify each payload as fixed, regressed, changed, unchanged, new, or removed')
  .argument('<baseline>', 'path to the baseline result JSON file')
  .argument('<current>', 'path to the current result JSON file')
  .action(async (baselinePath, currentPath) => {
    const logger = createLogger({});
    try {
      const [baseline, current] = await Promise.all([readResultFile(baselinePath), readResultFile(currentPath)]);
      const diff = diffResults(baseline, current);
      printDiffSummary(diff);
      process.exitCode = hasRegressions(diff) ? 1 : 0;
    } catch (err) {
      logger.error(err.message);
      process.exitCode = 2;
    }
  });

program.parse();
