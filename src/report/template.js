import { VALID_SEVERITIES } from '../corpus/schema.js';
import { DETERMINISTIC_RULE_NAMES } from '../scoring/deterministic.js';

// Critical first, per spec §5 Phase 5 task 2 ("Severity summary").
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// Embedding JSON inside a <script> element: the HTML parser looks for the
// literal byte sequence "</" while scanning script content, so a response
// that happens to contain "</script>" would truncate the block. Escaping
// the slash is the standard defusal.
function embedJson(value) {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

function formatDate(iso) {
  try {
    return new Date(iso).toUTCString();
  } catch {
    return iso;
  }
}

function formatPct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

function severityRank(sev) {
  const i = SEVERITY_ORDER.indexOf(sev);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

function rateClass(counts) {
  if (counts.failed > 0) return 'bad';
  if (counts.errored > 0) return 'warn';
  return 'good';
}

function renderHeader(run, summary) {
  return `
  <header class="report-header">
    <div class="scope-banner">
      <strong>llm-guard-probe</strong> tests systems the operator owns or has written permission to test.
      This report is not evidence of authorization to test any other system.
    </div>
    <h1>${escapeHtml(run.target)}</h1>
    <dl class="run-meta">
      <div><dt>Run started</dt><dd>${escapeHtml(formatDate(run.startedAt))}</dd></div>
      <div><dt>Adapter</dt><dd>${escapeHtml(run.adapter)}</dd></div>
      <div><dt>Corpus version</dt><dd class="mono" title="${escapeHtml(run.corpusVersion)}">${escapeHtml(run.corpusVersion.slice(0, 19))}…</dd></div>
      <div><dt>Duration</dt><dd>${(run.durationMs / 1000).toFixed(1)}s</dd></div>
      <div><dt>Run id</dt><dd class="mono">${escapeHtml(run.id)}</dd></div>
    </dl>
    <div class="headline ${rateClass(summary)}">
      <span class="headline-number">${formatPct(summary.passRate)}</span>
      <span class="headline-label">pass rate</span>
      <span class="headline-detail">${summary.passed} passed &middot; ${summary.failed} failed &middot; ${summary.errored} errored &middot; ${summary.total} total</span>
    </div>
  </header>`;
}

function renderSeveritySummary(bySeverity) {
  const rows = SEVERITY_ORDER.filter((s) => bySeverity[s]).map((sev) => {
    const c = bySeverity[sev];
    return `
      <div class="severity-card sev-${sev} ${rateClass(c)}">
        <div class="severity-name">${sev}</div>
        <div class="severity-count">${c.failed}<span class="of">/${c.total}</span></div>
        <div class="severity-caption">failed</div>
      </div>`;
  }).join('');

  return `
  <section id="severity-summary">
    <h2>Severity summary</h2>
    <p class="section-intro">Failures broken out by severity, most severe first.</p>
    <div class="severity-grid">${rows}</div>
  </section>`;
}

function renderCoverageMatrix(byCategory) {
  const categories = Object.keys(byCategory).sort();
  const rows = categories.map((cat) => {
    const c = byCategory[cat];
    const passedPct = c.total ? (c.passed / c.total) * 100 : 0;
    const failedPct = c.total ? (c.failed / c.total) * 100 : 0;
    const erroredPct = c.total ? (c.errored / c.total) * 100 : 0;
    return `
      <div class="coverage-row">
        <div class="coverage-label">${escapeHtml(cat)}</div>
        <div class="coverage-bar" role="img" aria-label="${escapeHtml(cat)}: ${formatPct(c.passRate)} pass rate">
          <span class="bar-pass" style="width:${passedPct}%"></span>
          <span class="bar-fail" style="width:${failedPct}%"></span>
          <span class="bar-error" style="width:${erroredPct}%"></span>
        </div>
        <div class="coverage-rate ${rateClass(c)}">${formatPct(c.passRate)}</div>
        <div class="coverage-count">${c.passed}/${c.total}</div>
      </div>`;
  }).join('');

  return `
  <section id="coverage-matrix">
    <h2>Coverage matrix</h2>
    <p class="section-intro">Pass rate by technique category. <span class="legend"><span class="swatch bar-pass"></span>passed <span class="swatch bar-fail"></span>failed <span class="swatch bar-error"></span>errored</span></p>
    <div class="coverage-matrix">${rows}</div>
  </section>`;
}

function renderRuleEvidence(rule) {
  const icon = rule.passed === true ? '✔' : rule.passed === false ? '✖' : '?';
  const cls = rule.passed === true ? 'pass' : rule.passed === false ? 'fail' : 'unknown';
  return `<li class="rule ${cls}"><span class="rule-icon">${icon}</span> <span class="rule-name">${escapeHtml(rule.rule)}</span><span class="rule-evidence">${escapeHtml(rule.evidence)}</span></li>`;
}

function renderFindings(results) {
  const failures = results
    .filter((r) => r.status === 'fail')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (failures.length === 0) {
    return `
  <section id="findings">
    <h2>Findings</h2>
    <p class="section-intro empty">No failing payloads in this run.</p>
  </section>`;
  }

  const items = failures.map((r) => `
      <details class="finding sev-${r.severity}" open>
        <summary>
          <span class="finding-severity">${escapeHtml(r.severity)}</span>
          <span class="finding-name">${escapeHtml(r.name)}</span>
          <span class="finding-id mono">${escapeHtml(r.payloadId)}</span>
          <span class="finding-category">${escapeHtml(r.category)}</span>
        </summary>
        <div class="finding-body">
          <div class="finding-block">
            <h4>Prompt sent</h4>
            <pre>${escapeHtml(r.prompt)}</pre>
          </div>
          <div class="finding-block">
            <h4>Response received</h4>
            <pre>${escapeHtml(r.response)}</pre>
          </div>
          <div class="finding-block">
            <h4>Rule evidence</h4>
            <ul class="rule-list">${r.rules.map(renderRuleEvidence).join('')}</ul>
          </div>
        </div>
      </details>`).join('');

  return `
  <section id="findings">
    <h2>Findings (${failures.length})</h2>
    <p class="section-intro">Every failing payload, expanded, with the exact prompt sent, the response received, and per-rule evidence.</p>
    ${items}
  </section>`;
}

function renderErrors(results) {
  const errored = results.filter((r) => r.status === 'error');
  if (errored.length === 0) return '';

  const items = errored.map((r) => {
    const reason = r.transportError
      ? `Transport error: ${r.transportError.message}${r.transportError.code ? ` (${r.transportError.code})` : ''}`
      : r.rules.find((ru) => ru.passed === null)?.evidence ?? 'Unknown scoring error.';
    return `
      <li class="error-item">
        <span class="finding-id mono">${escapeHtml(r.payloadId)}</span>
        <span class="finding-name">${escapeHtml(r.name)}</span>
        <span class="finding-category">${escapeHtml(r.category)}</span>
        <p class="error-reason">${escapeHtml(reason)}</p>
      </li>`;
  }).join('');

  return `
  <section id="errors">
    <h2>Execution errors (${errored.length})</h2>
    <p class="section-intro">These payloads could not be scored — a transport failure, or a rule that isn't implemented yet. They are <strong>not</strong> counted as failures (see Methodology).</p>
    <ul class="error-list">${items}</ul>
  </section>`;
}

const STATUS_LABEL = { pass: 'pass', fail: 'fail', error: 'error' };

function renderFullResults(results) {
  const categories = [...new Set(results.map((r) => r.category))].sort();
  const rows = [...results]
    .sort((a, b) => a.category.localeCompare(b.category) || a.payloadId.localeCompare(b.payloadId))
    .map((r) => `
      <tr data-category="${escapeHtml(r.category)}" data-severity="${escapeHtml(r.severity)}" data-status="${escapeHtml(r.status)}" data-search="${escapeHtml(`${r.payloadId} ${r.name}`.toLowerCase())}">
        <td class="mono">${escapeHtml(r.payloadId)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.category)}</td>
        <td><span class="badge sev-${r.severity}">${escapeHtml(r.severity)}</span></td>
        <td><span class="badge status-${r.status}">${STATUS_LABEL[r.status] ?? escapeHtml(r.status)}</span></td>
        <td class="num">${r.latencyMs ?? '—'}</td>
      </tr>`).join('');

  const categoryOptions = categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const severityOptions = VALID_SEVERITIES.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  return `
  <section id="full-results">
    <h2>Full results (${results.length})</h2>
    <p class="section-intro">Every payload run, filterable.</p>
    <div class="filters">
      <input type="search" id="filter-search" placeholder="Search id or name…" aria-label="Search by id or name">
      <select id="filter-category" aria-label="Filter by category"><option value="">All categories</option>${categoryOptions}</select>
      <select id="filter-severity" aria-label="Filter by severity"><option value="">All severities</option>${severityOptions}</select>
      <select id="filter-status" aria-label="Filter by status">
        <option value="">All statuses</option>
        <option value="pass">pass</option>
        <option value="fail">fail</option>
        <option value="error">error</option>
      </select>
      <span id="filter-count" class="filter-count"></span>
    </div>
    <div class="table-scroll">
      <table id="results-table">
        <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Severity</th><th>Status</th><th>ms</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderJudgeStatus(run, results) {
  const usesJudge = results.some((r) => r.rules?.some((rule) => rule.rule === 'judge'));
  if (!usesJudge) {
    return `<p>No payload in this run declared a <code>judge</code> rule, so the LLM-as-judge layer was not
    invoked.</p>`;
  }
  if (run.judgeModel) {
    return `<p>This run evaluated <code>judge</code> rules with <code>${escapeHtml(run.judgeModel)}</code> as the
    judge model. The judge only runs for payloads whose deterministic rules all passed first — a deterministic
    failure short-circuits the payload before a judge call is spent on it (see the "Judge call skipped" evidence
    where that happened).</p>`;
  }
  return `<p class="judge-skipped"><strong>Judging was skipped for this run${run.judgeSkipReason ? `: ${escapeHtml(run.judgeSkipReason)}` : '.'
    }</strong> Every payload with a <code>judge</code> rule is scored <code>error</code>, not silently passed or
    failed — see Full results / Execution errors above. Re-run with judging enabled (and
    <code>ANTHROPIC_API_KEY</code> set) to evaluate them.</p>`;
}

function renderMethodology(run, results) {
  const ruleList = DETERMINISTIC_RULE_NAMES.map((r) => `<code>${escapeHtml(r)}</code>`).join(', ');
  return `
  <section id="methodology">
    <h2>Methodology</h2>
    <h3>Scoring</h3>
    <p>Each payload declares one or more <code>expect</code> rules. A payload <strong>passes</strong> only if every
    rule evaluates cleanly and passes. Deterministic rules implemented in this run: ${ruleList}. A canary token
    unique to this run is substituted into the target's system prompt; <code>no_canary_leak</code> checks it never
    reappears in a response.</p>
    <p>A rule that <strong>throws</strong> during evaluation — or a request that fails at the transport level — is
    scored <code>error</code>, never <code>fail</code>. Errored payloads are excluded from the pass rate; conflating
    "the target failed this check" with "we couldn't run this check" would misrepresent the guardrail's behaviour.</p>
    <h3>The <code>must_refuse</code> heuristic — honestly stated</h3>
    <p>This is the weakest deterministic rule, and it is important to be upfront about why. It matches a fixed list
    of common refusal phrases (e.g. "I can't", "I'm not able to"), then additionally requires the response be
    reasonably short and free of the canary. It is <strong>keyword matching, not language understanding</strong>:
    it will false-negative on a genuine refusal phrased without any of these markers, and it can false-positive on a
    response that opens with a refusal-shaped sentence and then complies anyway. It cannot detect partial
    compliance ("I can't share the full code, but here's half of it…"). Wherever a concrete pattern is available,
    prefer <code>must_not_match</code> / <code>must_not_contain</code> over <code>must_refuse</code>. This gap is
    exactly what the <code>judge</code> rule below is for.</p>
    <h3>The <code>judge</code> rule (LLM-as-judge)</h3>
    <p>For payloads where refusal is genuinely ambiguous — no fixed pattern reliably distinguishes a real refusal
    from partial compliance — a payload can declare a <code>judge</code> rule with a plain-language
    <code>criterion</code>. A separate model call evaluates the response strictly against that one criterion and
    returns <code>{"verdict": "pass"|"fail", "reasoning": "…"}</code>; the prompt template is versioned in
    <code>prompts/judge-prompt.md</code> so changes to how the judge reasons are auditable like any other change to
    methodology. A judge response that isn't valid, strictly-shaped JSON is scored <code>error</code>, never
    silently treated as a pass.</p>
    <p><strong>The judge is itself a fallible LLM, not a ground-truth oracle.</strong> Treat a judge verdict as an
    informed second opinion, not proof — it can be wrong in either direction, and unlike the deterministic rules its
    reasoning cannot be independently re-derived from the response text alone. That is why it is one layer among
    several rather than the only layer.</p>
    ${renderJudgeStatus(run, results)}
    <h3>Corpus provenance</h3>
    <p>Payloads are drawn only from publicly documented technique families (the OWASP LLM Top 10 and published
    research) — this project does not author or distribute novel bypass techniques. Each corpus file cites its
    source family in a <code>reference</code> field; see <code>corpus/README.md</code> in the project repository for
    the full citation list and contribution policy. This run's exact corpus content is fingerprinted above as
    "Corpus version" (a SHA-256 over the loaded corpus files), so results are reproducible against a known payload
    set.</p>
    <h3>Scope</h3>
    <p><strong>llm-guard-probe</strong> is a defensive tool. It is intended to test systems the operator owns or has
    written permission to test. A passing or failing result in this report says nothing about the authorization
    status of the target — that is the operator's responsibility, not this tool's.</p>
  </section>`;
}

function renderLimitations() {
  return `
  <section id="limitations">
    <h2>Limitations</h2>
    <ul class="limitations-list">
      <li><strong>Non-determinism.</strong> LLM outputs vary run to run, even at fixed parameters. A single run is a
      sample, not a guarantee — a passing payload today can fail tomorrow with no code change on either side, and
      vice versa. Treat this report as a point-in-time snapshot, and re-run periodically or in CI.</li>
      <li><strong>Single-turn only.</strong> Every payload in this corpus is a single request/response exchange.
      Multi-turn escalation, where a model is worn down or steered gradually across a conversation, is not
      exercised here and is a known gap.</li>
      <li><strong>Heuristic scoring.</strong> Deterministic rules other than exact pattern/substring matches — most
      notably <code>must_refuse</code> — are heuristics, not semantic understanding. The <code>judge</code> rule
      trades that heuristic for a different model's judgement, which is a fallible opinion, not ground truth. See
      Methodology for specifics. An <code>error</code> status means a check could not run, not that the target
      passed it.</li>
      <li><strong>Coverage, not exhaustiveness.</strong> This corpus illustrates known technique <em>families</em>.
      It is not, and does not claim to be, an exhaustive test of every possible phrasing or bypass.</li>
    </ul>
  </section>`;
}

const STYLE = `
  :root {
    --bg: #ffffff;
    --bg-subtle: #f7f7f8;
    --border: #e2e2e5;
    --text: #1c1c1f;
    --text-muted: #5a5a63;
    --accent: #2b2b6b;
    --good: #15803d;
    --good-bg: #ecfdf3;
    --warn: #b45309;
    --warn-bg: #fffbeb;
    --bad: #b91c1c;
    --bad-bg: #fef2f2;
    --radius: 8px;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--font);
    color: var(--text);
    background: var(--bg-subtle);
    line-height: 1.5;
  }
  main, .report-header { max-width: 960px; margin: 0 auto; padding: 0 24px; }
  h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.01em; }
  h1 { font-size: 1.9rem; margin: 0.2em 0 0.4em; }
  h2 { font-size: 1.3rem; margin-top: 2.5em; padding-top: 0.75em; border-top: 1px solid var(--border); }
  h3 { font-size: 1.05rem; margin-top: 1.6em; }
  h4 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 0.4em; }
  code { font-family: var(--font-mono); background: var(--bg-subtle); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
  .mono { font-family: var(--font-mono); font-size: 0.92em; }
  p.section-intro { color: var(--text-muted); margin-top: -0.3em; }
  p.section-intro.empty { color: var(--good); }

  .report-header { background: var(--bg); padding-top: 28px; padding-bottom: 28px; }
  .scope-banner {
    background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 10px 14px; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 18px;
  }
  .run-meta { display: flex; flex-wrap: wrap; gap: 20px 32px; margin: 1em 0; padding: 0; }
  .run-meta div { display: flex; flex-direction: column; }
  .run-meta dt { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 0; }
  .run-meta dd { margin: 0.15em 0 0; font-size: 0.92rem; }

  .headline {
    margin-top: 1.4em; padding: 20px 24px; border-radius: var(--radius);
    display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 16px;
    border: 1px solid var(--border);
  }
  .headline.good { background: var(--good-bg); }
  .headline.warn { background: var(--warn-bg); }
  .headline.bad { background: var(--bad-bg); }
  .headline-number { font-size: 2.6rem; font-weight: 700; line-height: 1; }
  .headline.good .headline-number { color: var(--good); }
  .headline.warn .headline-number { color: var(--warn); }
  .headline.bad .headline-number { color: var(--bad); }
  .headline-label { font-size: 1rem; color: var(--text-muted); }
  .headline-detail { flex-basis: 100%; font-size: 0.88rem; color: var(--text-muted); }

  main { background: var(--bg); padding-bottom: 60px; }

  .severity-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .severity-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .severity-card.good { border-left: 4px solid var(--good); }
  .severity-card.warn { border-left: 4px solid var(--warn); }
  .severity-card.bad { border-left: 4px solid var(--bad); }
  .severity-name { text-transform: capitalize; font-size: 0.8rem; color: var(--text-muted); }
  .severity-count { font-size: 1.6rem; font-weight: 700; }
  .severity-count .of { font-size: 1rem; font-weight: 400; color: var(--text-muted); }
  .severity-caption { font-size: 0.75rem; color: var(--text-muted); }

  .coverage-matrix { display: flex; flex-direction: column; gap: 10px; }
  .coverage-row { display: grid; grid-template-columns: 160px 1fr 60px 60px; align-items: center; gap: 12px; }
  .coverage-label { font-size: 0.88rem; }
  .coverage-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--border); }
  .bar-pass { background: var(--good); display: inline-block; }
  .bar-fail { background: var(--bad); display: inline-block; }
  .bar-error { background: var(--warn); display: inline-block; }
  .coverage-rate { font-weight: 600; font-size: 0.88rem; text-align: right; }
  .coverage-rate.good { color: var(--good); }
  .coverage-rate.warn { color: var(--warn); }
  .coverage-rate.bad { color: var(--bad); }
  .coverage-count { color: var(--text-muted); font-size: 0.82rem; }
  .legend { float: right; font-size: 0.8rem; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 12px; vertical-align: middle; }
  .swatch.bar-pass:first-child { margin-left: 0; }

  .finding { border: 1px solid var(--border); border-left-width: 4px; border-radius: var(--radius); margin-bottom: 14px; }
  .finding.sev-critical, .finding.sev-high { border-left-color: var(--bad); }
  .finding.sev-medium { border-left-color: var(--warn); }
  .finding.sev-low { border-left-color: var(--text-muted); }
  .finding summary {
    cursor: pointer; padding: 12px 16px; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
    list-style: none;
  }
  .finding summary::-webkit-details-marker { display: none; }
  .finding-severity { text-transform: uppercase; font-size: 0.72rem; font-weight: 700; color: var(--bad); letter-spacing: 0.03em; }
  .finding.sev-medium .finding-severity { color: var(--warn); }
  .finding.sev-low .finding-severity { color: var(--text-muted); }
  .finding-name { font-weight: 600; }
  .finding-id { color: var(--text-muted); }
  .finding-category { margin-left: auto; font-size: 0.8rem; color: var(--text-muted); background: var(--bg-subtle); padding: 2px 8px; border-radius: 999px; }
  .finding-body { padding: 0 16px 16px; }
  .finding-block { margin-bottom: 14px; }
  .finding-block pre {
    background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px;
    white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 0.85rem; margin: 0;
  }
  .rule-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .rule { display: flex; gap: 8px; align-items: baseline; font-size: 0.86rem; }
  .rule-icon { width: 1em; }
  .rule.pass .rule-icon { color: var(--good); }
  .rule.fail .rule-icon { color: var(--bad); }
  .rule.unknown .rule-icon { color: var(--warn); }
  .rule-name { font-family: var(--font-mono); font-weight: 600; }
  .rule-evidence { color: var(--text-muted); }

  .error-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .error-item { border: 1px solid var(--border); border-left: 4px solid var(--warn); border-radius: var(--radius); padding: 10px 16px; }
  .error-reason { margin: 6px 0 0; color: var(--text-muted); font-size: 0.88rem; }

  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
  .filters input, .filters select {
    font: inherit; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
  }
  .filters input { flex: 1 1 200px; }
  .filter-count { margin-left: auto; font-size: 0.82rem; color: var(--text-muted); }

  .table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; min-width: 640px; }
  thead th { text-align: left; background: var(--bg-subtle); padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.filtered-out { display: none; }
  td.num { text-align: right; font-family: var(--font-mono); }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.76rem; font-weight: 600; text-transform: capitalize; }
  .badge.sev-critical, .badge.sev-high { background: var(--bad-bg); color: var(--bad); }
  .badge.sev-medium { background: var(--warn-bg); color: var(--warn); }
  .badge.sev-low { background: var(--bg-subtle); color: var(--text-muted); }
  .badge.status-pass { background: var(--good-bg); color: var(--good); }
  .badge.status-fail { background: var(--bad-bg); color: var(--bad); }
  .badge.status-error { background: var(--warn-bg); color: var(--warn); }

  .limitations-list { padding-left: 1.2em; display: flex; flex-direction: column; gap: 10px; }
  .judge-skipped { background: var(--warn-bg); border: 1px solid var(--border); border-left: 4px solid var(--warn); border-radius: var(--radius); padding: 10px 14px; }

  footer { max-width: 960px; margin: 0 auto; padding: 24px; color: var(--text-muted); font-size: 0.8rem; }

  @media (max-width: 640px) {
    .coverage-row { grid-template-columns: 100px 1fr 46px; }
    .coverage-count { display: none; }
    .run-meta { gap: 12px 20px; }
    .headline-number { font-size: 2rem; }
  }
`;

const SCRIPT = `
(function () {
  var search = document.getElementById('filter-search');
  var category = document.getElementById('filter-category');
  var severity = document.getElementById('filter-severity');
  var status = document.getElementById('filter-status');
  var count = document.getElementById('filter-count');
  var rows = Array.prototype.slice.call(document.querySelectorAll('#results-table tbody tr'));
  if (!search) return;

  function apply() {
    var q = search.value.trim().toLowerCase();
    var cat = category.value;
    var sev = severity.value;
    var st = status.value;
    var visible = 0;
    rows.forEach(function (row) {
      var matches =
        (!q || row.dataset.search.indexOf(q) !== -1) &&
        (!cat || row.dataset.category === cat) &&
        (!sev || row.dataset.severity === sev) &&
        (!st || row.dataset.status === st);
      row.classList.toggle('filtered-out', !matches);
      if (matches) visible += 1;
    });
    count.textContent = visible + ' / ' + rows.length + ' shown';
  }

  [search, category, severity, status].forEach(function (el) {
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  apply();
})();
`;

/**
 * Renders the full self-contained HTML report for a §4.4 result file.
 * No external requests: CSS and JS are inlined, and the raw result JSON is
 * embedded verbatim in a <script type="application/json"> block so the
 * report also carries its own machine-readable data (e.g. for later diffing).
 */
export function renderHtmlReport(resultFile) {
  const { run, summary, results } = resultFile;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-guard-probe report — ${escapeHtml(run.target)}</title>
<style>${STYLE}</style>
</head>
<body>
${renderHeader(run, summary)}
<main>
${renderSeveritySummary(summary.bySeverity)}
${renderCoverageMatrix(summary.byCategory)}
${renderFindings(results)}
${renderErrors(results)}
${renderFullResults(results)}
${renderMethodology(run, results)}
${renderLimitations()}
</main>
<footer>Generated by llm-guard-probe. schemaVersion ${resultFile.schemaVersion} · run ${escapeHtml(run.id)}</footer>
<script type="application/json" id="result-data">${embedJson(resultFile)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
