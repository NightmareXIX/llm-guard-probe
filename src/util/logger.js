import pc from 'picocolors';

const LEVELS = { quiet: 0, normal: 1, verbose: 2 };

/**
 * Levelled logger writing to stderr, so stdout stays clean for piping
 * machine-readable output (result tables, JSON, etc).
 */
export function createLogger({ quiet = false, verbose = false } = {}) {
  const level = quiet ? LEVELS.quiet : verbose ? LEVELS.verbose : LEVELS.normal;

  const write = (min, line) => {
    if (level >= min) process.stderr.write(line + '\n');
  };

  return {
    error: (msg) => write(LEVELS.quiet, pc.red(`✖ ${msg}`)),
    warn: (msg) => write(LEVELS.normal, pc.yellow(`⚠ ${msg}`)),
    info: (msg) => write(LEVELS.normal, msg),
    success: (msg) => write(LEVELS.normal, pc.green(`✔ ${msg}`)),
    debug: (msg) => write(LEVELS.verbose, pc.dim(`  ${msg}`)),
  };
}
