import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// slopcad port of the launch-mommy quality-report donor: coverage + CRAP +
// jscpd JSON outputs merged into one local HTML dashboard. Report-only.
const reportInputs = {
  coverage: [
    {
      name: "Web",
      packagePath: "apps/web",
      jsonPath: "apps/web/coverage/coverage-final.json",
      htmlPath: "apps/web/coverage/index.html",
    },
    {
      name: "UI",
      packagePath: "packages/ui",
      jsonPath: "packages/ui/coverage/coverage-final.json",
      htmlPath: "packages/ui/coverage/index.html",
    },
    {
      name: "API",
      packagePath: "packages/api",
      jsonPath: "packages/api/coverage/coverage-final.json",
      htmlPath: "packages/api/coverage/index.html",
    },
    {
      name: "Auth",
      packagePath: "packages/auth",
      jsonPath: "packages/auth/coverage/coverage-final.json",
      htmlPath: "packages/auth/coverage/index.html",
    },
    {
      name: "DB",
      packagePath: "packages/db",
      jsonPath: "packages/db/coverage/coverage-final.json",
      htmlPath: "packages/db/coverage/index.html",
    },
    {
      name: "Env",
      packagePath: "packages/env",
      jsonPath: "packages/env/coverage/coverage-final.json",
      htmlPath: "packages/env/coverage/index.html",
    },
  ],
  crap: [
    {
      name: "Web",
      packagePath: "apps/web",
      jsonPath: "reports/crap/web.json",
      htmlPath: "reports/crap/web-html/index.html",
    },
    {
      name: "UI",
      packagePath: "packages/ui",
      jsonPath: "reports/crap/ui.json",
      htmlPath: "reports/crap/ui-html/index.html",
    },
    {
      name: "API",
      packagePath: "packages/api",
      jsonPath: "reports/crap/api.json",
      htmlPath: "reports/crap/api-html/index.html",
    },
    {
      name: "Auth",
      packagePath: "packages/auth",
      jsonPath: "reports/crap/auth.json",
      htmlPath: "reports/crap/auth-html/index.html",
    },
    {
      name: "DB",
      packagePath: "packages/db",
      jsonPath: "reports/crap/db.json",
      htmlPath: "reports/crap/db-html/index.html",
    },
    {
      name: "Env",
      packagePath: "packages/env",
      jsonPath: "reports/crap/env.json",
      htmlPath: "reports/crap/env-html/index.html",
    },
  ],
  duplication: {
    jsonPath: "reports/jscpd/jscpd-report.json",
    htmlPath: "reports/jscpd/html/index.html",
  },
};

const outputPath = process.argv[2] ?? "reports/quality/index.html";
const absoluteOutputPath = path.resolve(repoRoot, outputPath);
const outputDir = path.dirname(absoluteOutputPath);

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(1)}%`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeHref(targetPath) {
  return path
    .relative(outputDir, path.resolve(repoRoot, targetPath))
    .replaceAll(path.sep, "/");
}

function sourceHref(filePath, line = 1) {
  return `vscode://file/${path.resolve(repoRoot, filePath)}:${line}`;
}

async function readJson(relativePath) {
  const content = await readFile(path.resolve(repoRoot, relativePath), "utf8");
  return JSON.parse(content);
}

function ratio(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

function summarizeCoverageFile(fileCoverage) {
  const statementCounts = Object.values(fileCoverage.s ?? {});
  const statementTotal = statementCounts.length;
  const statementCovered = statementCounts.filter((count) => count > 0).length;

  const functionCounts = Object.values(fileCoverage.f ?? {});
  const functionTotal = functionCounts.length;
  const functionCovered = functionCounts.filter((count) => count > 0).length;

  const branchCounts = Object.values(fileCoverage.b ?? {}).flat();
  const branchTotal = branchCounts.length;
  const branchCovered = branchCounts.filter((count) => count > 0).length;

  const lines = new Map();
  for (const [statementId, location] of Object.entries(
    fileCoverage.statementMap ?? {},
  )) {
    const line = location?.start?.line;
    if (typeof line !== "number") {
      continue;
    }
    const count = fileCoverage.s?.[statementId] ?? 0;
    lines.set(line, (lines.get(line) ?? 0) + count);
  }

  const lineCounts = [...lines.values()];
  const lineTotal = lineCounts.length;
  const lineCovered = lineCounts.filter((count) => count > 0).length;

  return {
    statements: {
      covered: statementCovered,
      total: statementTotal,
      pct: ratio(statementCovered, statementTotal),
    },
    branches: {
      covered: branchCovered,
      total: branchTotal,
      pct: ratio(branchCovered, branchTotal),
    },
    functions: {
      covered: functionCovered,
      total: functionTotal,
      pct: ratio(functionCovered, functionTotal),
    },
    lines: {
      covered: lineCovered,
      total: lineTotal,
      pct: ratio(lineCovered, lineTotal),
    },
  };
}

function addCoverageTotals(target, summary) {
  for (const key of ["statements", "branches", "functions", "lines"]) {
    target[key].covered += summary[key].covered;
    target[key].total += summary[key].total;
    target[key].pct = ratio(target[key].covered, target[key].total);
  }
}

function emptyCoverageTotals() {
  return {
    statements: { covered: 0, total: 0, pct: 100 },
    branches: { covered: 0, total: 0, pct: 100 },
    functions: { covered: 0, total: 0, pct: 100 },
    lines: { covered: 0, total: 0, pct: 100 },
  };
}

async function collectCoverage() {
  const packages = [];
  const global = emptyCoverageTotals();

  for (const input of reportInputs.coverage) {
    const data = await readJson(input.jsonPath);
    const totals = emptyCoverageTotals();
    const files = [];

    for (const [absoluteFilePath, fileCoverage] of Object.entries(data)) {
      const relativeFilePath = path
        .relative(repoRoot, absoluteFilePath)
        .replaceAll(path.sep, "/");
      const summary = summarizeCoverageFile(fileCoverage);
      addCoverageTotals(totals, summary);
      files.push({
        packageName: input.name,
        filePath: relativeFilePath,
        ...summary,
      });
    }

    addCoverageTotals(global, totals);
    packages.push({ ...input, totals, files });
  }

  const offenders = packages
    .flatMap((item) => item.files)
    .filter((item) => item.lines.total > 0)
    .sort((a, b) => a.lines.pct - b.lines.pct || b.lines.total - a.lines.total)
    .slice(0, 12);

  return { packages, global, offenders };
}

async function collectCrap() {
  const packages = [];
  const functions = [];

  for (const input of reportInputs.crap) {
    const data = await readJson(input.jsonPath);
    const packageFunctions = [];

    for (const [filePath, fileReport] of Object.entries(data)) {
      for (const [functionName, report] of Object.entries(fileReport)) {
        const fullPath = [input.packagePath, "src", filePath].join("/");
        const item = {
          packageName: input.name,
          filePath: fullPath,
          functionName,
          descriptor: report.functionDescriptor ?? functionName,
          line: report.start?.line ?? 1,
          complexity: report.complexity ?? 0,
          coverage: (report.statements?.coverage ?? 0) * 100,
          crap: report.statements?.crap ?? 0,
          uncoveredLines: Array.isArray(report.uncoveredLines)
            ? report.uncoveredLines.length
            : 0,
        };
        packageFunctions.push(item);
        functions.push(item);
      }
    }

    const highRisk = packageFunctions.filter((item) => item.crap >= 30).length;
    const averageCrap = packageFunctions.length
      ? packageFunctions.reduce((sum, item) => sum + item.crap, 0) /
        packageFunctions.length
      : 0;

    packages.push({
      ...input,
      functionCount: packageFunctions.length,
      highRisk,
      averageCrap,
    });
  }

  const offenders = functions
    .sort((a, b) => b.crap - a.crap || b.complexity - a.complexity)
    .slice(0, 12);
  const highRisk = functions.filter((item) => item.crap >= 30).length;
  const averageCrap = functions.length
    ? functions.reduce((sum, item) => sum + item.crap, 0) / functions.length
    : 0;

  return { packages, functions, offenders, highRisk, averageCrap };
}

async function collectDuplication() {
  const data = await readJson(reportInputs.duplication.jsonPath);
  const formats = data.statistics?.formats ?? {};
  const clones = Array.isArray(data.duplicates) ? data.duplicates : [];

  const totals = {
    files: 0,
    lines: 0,
    tokens: 0,
    clones: clones.length,
    duplicatedLines: 0,
    duplicatedTokens: 0,
    percentage: 0,
  };
  const files = [];
  const formatSummaries = [];

  for (const [format, formatStats] of Object.entries(formats)) {
    const sources = formatStats.sources ?? {};
    const formatSummary = {
      format,
      files: 0,
      lines: 0,
      tokens: 0,
      clones: 0,
      duplicatedLines: 0,
      duplicatedTokens: 0,
      percentage: 0,
    };

    for (const [filePath, source] of Object.entries(sources)) {
      const item = {
        format,
        filePath,
        lines: source.lines ?? 0,
        tokens: source.tokens ?? 0,
        clones: source.clones ?? 0,
        duplicatedLines: source.duplicatedLines ?? 0,
        duplicatedTokens: source.duplicatedTokens ?? 0,
        percentage: source.percentage ?? 0,
      };

      files.push(item);
      formatSummary.files += 1;
      formatSummary.lines += item.lines;
      formatSummary.tokens += item.tokens;
      formatSummary.clones += item.clones;
      formatSummary.duplicatedLines += item.duplicatedLines;
      formatSummary.duplicatedTokens += item.duplicatedTokens;
    }

    formatSummary.percentage = ratio(
      formatSummary.duplicatedLines,
      formatSummary.lines,
    );
    formatSummaries.push(formatSummary);
    totals.files += formatSummary.files;
    totals.lines += formatSummary.lines;
    totals.tokens += formatSummary.tokens;
    totals.duplicatedLines += formatSummary.duplicatedLines;
    totals.duplicatedTokens += formatSummary.duplicatedTokens;
  }

  totals.percentage = ratio(totals.duplicatedLines, totals.lines);

  const offenders = files
    .filter((item) => item.duplicatedLines > 0)
    .sort(
      (a, b) =>
        b.duplicatedLines - a.duplicatedLines || b.percentage - a.percentage,
    )
    .slice(0, 12);

  const cloneOffenders = clones
    .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
    .slice(0, 8);

  return { totals, formats: formatSummaries, offenders, cloneOffenders };
}

function metricCard(label, value, detail, tone = "slate") {
  const tones = {
    slate: "border-slate-700 bg-slate-900 text-slate-100",
    green: "border-emerald-500/30 bg-emerald-950/40 text-emerald-100",
    amber: "border-amber-500/30 bg-amber-950/40 text-amber-100",
    red: "border-rose-500/30 bg-rose-950/40 text-rose-100",
  };
  return `<div class="rounded-2xl border ${tones[tone]} p-5 shadow-sm">
    <div class="text-sm font-medium text-slate-400">${escapeHtml(label)}</div>
    <div class="mt-3 text-3xl font-semibold tracking-tight">${escapeHtml(value)}</div>
    <div class="mt-2 text-sm text-slate-400">${escapeHtml(detail)}</div>
  </div>`;
}

function toneForCoverage(value) {
  if (value >= 80) return "green";
  if (value >= 60) return "amber";
  return "red";
}

function toneForCrap(count) {
  if (count === 0) return "green";
  if (count < 10) return "amber";
  return "red";
}

function toneForDuplication(value) {
  if (value < 2) return "green";
  if (value < 5) return "amber";
  return "red";
}

function sectionHeader(id, eyebrow, title, description, links = []) {
  const renderedLinks = links
    .map(
      (link) =>
        `<a class="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-sm font-medium text-slate-300 hover:border-blue-400 hover:bg-slate-800 hover:text-white" href="${escapeHtml(relativeHref(link.href))}">${escapeHtml(link.label)}</a>`,
    )
    .join("");

  return `<div id="${escapeHtml(id)}" class="scroll-mt-8 border-t border-slate-800 pt-10">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">${escapeHtml(eyebrow)}</div>
        <h2 class="mt-2 text-2xl font-semibold tracking-tight text-slate-100">${escapeHtml(title)}</h2>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-400">${escapeHtml(description)}</p>
      </div>
      <div class="flex flex-wrap gap-2">${renderedLinks}</div>
    </div>
  </div>`;
}

function coverageTable(offenders) {
  return `<div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-sm">
    <table class="w-full text-left text-sm">
      <thead class="bg-slate-950 text-xs uppercase tracking-wide text-slate-400">
        <tr><th class="px-4 py-3">File</th><th class="px-4 py-3">Lines</th><th class="px-4 py-3">Branches</th><th class="px-4 py-3">Functions</th><th class="px-4 py-3">Statements</th></tr>
      </thead>
      <tbody class="divide-y divide-slate-800 text-slate-300">
        ${offenders
          .map(
            (item) => `<tr class="align-top">
              <td class="px-4 py-3"><a class="font-medium text-slate-100 hover:text-blue-300" href="${escapeHtml(sourceHref(item.filePath))}">${escapeHtml(item.filePath)}</a><div class="text-xs text-slate-500">${escapeHtml(item.packageName)}</div></td>
              <td class="px-4 py-3 font-semibold ${item.lines.pct < 50 ? "text-rose-300" : "text-slate-300"}">${formatPercent(item.lines.pct)}<div class="text-xs font-normal text-slate-500">${item.lines.covered}/${item.lines.total}</div></td>
              <td class="px-4 py-3">${formatPercent(item.branches.pct)}</td>
              <td class="px-4 py-3">${formatPercent(item.functions.pct)}</td>
              <td class="px-4 py-3">${formatPercent(item.statements.pct)}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function crapTable(offenders) {
  return `<div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-sm">
    <table class="w-full text-left text-sm">
      <thead class="bg-slate-950 text-xs uppercase tracking-wide text-slate-400">
        <tr><th class="px-4 py-3">Function</th><th class="px-4 py-3">CRAP</th><th class="px-4 py-3">Complexity</th><th class="px-4 py-3">Coverage</th><th class="px-4 py-3">Uncovered lines</th></tr>
      </thead>
      <tbody class="divide-y divide-slate-800 text-slate-300">
        ${offenders
          .map(
            (item) => `<tr class="align-top">
              <td class="px-4 py-3"><a class="font-medium text-slate-100 hover:text-blue-300" href="${escapeHtml(sourceHref(item.filePath, item.line))}">${escapeHtml(item.descriptor)}</a><div class="mt-1 text-xs text-slate-500">${escapeHtml(item.filePath)}:${item.line}</div></td>
              <td class="px-4 py-3 font-semibold ${item.crap >= 30 ? "text-rose-300" : "text-slate-300"}">${item.crap.toFixed(1)}</td>
              <td class="px-4 py-3">${item.complexity}</td>
              <td class="px-4 py-3">${formatPercent(item.coverage)}</td>
              <td class="px-4 py-3">${item.uncoveredLines}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function duplicationTable(offenders) {
  return `<div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-sm">
    <table class="w-full text-left text-sm">
      <thead class="bg-slate-950 text-xs uppercase tracking-wide text-slate-400">
        <tr><th class="px-4 py-3">File</th><th class="px-4 py-3">Duplicated lines</th><th class="px-4 py-3">File duplication</th><th class="px-4 py-3">Clones</th><th class="px-4 py-3">Format</th></tr>
      </thead>
      <tbody class="divide-y divide-slate-800 text-slate-300">
        ${offenders
          .map(
            (item) => `<tr class="align-top">
              <td class="px-4 py-3"><a class="font-medium text-slate-100 hover:text-blue-300" href="${escapeHtml(sourceHref(item.filePath))}">${escapeHtml(item.filePath)}</a></td>
              <td class="px-4 py-3 font-semibold text-slate-200">${formatNumber(item.duplicatedLines)}</td>
              <td class="px-4 py-3 ${item.percentage >= 10 ? "font-semibold text-rose-300" : "text-slate-300"}">${formatPercent(item.percentage)}</td>
              <td class="px-4 py-3">${item.clones}</td>
              <td class="px-4 py-3"><span class="rounded-full bg-slate-800 px-2 py-1 text-xs font-medium text-slate-300">${escapeHtml(item.format)}</span></td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function cloneCards(clones) {
  return `<div class="grid gap-3 lg:grid-cols-2">
    ${clones
      .map(
        (
          item,
        ) => `<div class="rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold text-slate-100">${formatNumber(item.lines ?? 0)} duplicated lines</div>
            <span class="rounded-full bg-slate-800 px-2 py-1 text-xs font-medium text-slate-300">${escapeHtml(item.format ?? "unknown")}</span>
          </div>
          <div class="mt-3 space-y-2 text-sm text-slate-400">
            <a class="block truncate hover:text-blue-300" href="${escapeHtml(sourceHref(item.firstFile?.name ?? "", item.firstFile?.start ?? 1))}">${escapeHtml(item.firstFile?.name ?? "unknown")}:${item.firstFile?.start ?? "?"}-${item.firstFile?.end ?? "?"}</a>
            <a class="block truncate hover:text-blue-300" href="${escapeHtml(sourceHref(item.secondFile?.name ?? "", item.secondFile?.start ?? 1))}">${escapeHtml(item.secondFile?.name ?? "unknown")}:${item.secondFile?.start ?? "?"}-${item.secondFile?.end ?? "?"}</a>
          </div>
        </div>`,
      )
      .join("")}
  </div>`;
}

function renderPackageCoverage(packages) {
  return `<div class="grid gap-4 md:grid-cols-2">
    ${packages
      .map(
        (
          item,
        ) => `<div class="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <div class="flex items-center justify-between gap-3"><h3 class="font-semibold text-slate-100">${escapeHtml(item.name)}</h3><a class="text-sm font-medium text-blue-300 hover:text-blue-200" href="${escapeHtml(relativeHref(item.htmlPath))}">Open full coverage</a></div>
          <div class="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div><div class="text-slate-500">Lines</div><div class="text-lg font-semibold text-slate-100">${formatPercent(item.totals.lines.pct)}</div></div>
            <div><div class="text-slate-500">Branches</div><div class="text-lg font-semibold text-slate-100">${formatPercent(item.totals.branches.pct)}</div></div>
            <div><div class="text-slate-500">Functions</div><div class="text-lg font-semibold text-slate-100">${formatPercent(item.totals.functions.pct)}</div></div>
            <div><div class="text-slate-500">Statements</div><div class="text-lg font-semibold text-slate-100">${formatPercent(item.totals.statements.pct)}</div></div>
          </div>
        </div>`,
      )
      .join("")}
  </div>`;
}

function renderCrapPackages(packages) {
  return `<div class="grid gap-4 md:grid-cols-2">
    ${packages
      .map(
        (
          item,
        ) => `<div class="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <div class="flex items-center justify-between gap-3"><h3 class="font-semibold text-slate-100">${escapeHtml(item.name)}</h3><a class="text-sm font-medium text-blue-300 hover:text-blue-200" href="${escapeHtml(relativeHref(item.htmlPath))}">Open CRAP report</a></div>
          <div class="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div><div class="text-slate-500">Functions</div><div class="text-lg font-semibold text-slate-100">${formatNumber(item.functionCount)}</div></div>
            <div><div class="text-slate-500">High risk</div><div class="text-lg font-semibold ${item.highRisk > 0 ? "text-rose-300" : "text-emerald-300"}">${formatNumber(item.highRisk)}</div></div>
            <div><div class="text-slate-500">Avg CRAP</div><div class="text-lg font-semibold text-slate-100">${item.averageCrap.toFixed(1)}</div></div>
          </div>
        </div>`,
      )
      .join("")}
  </div>`;
}

function renderDuplicationFormats(formats) {
  return `<div class="grid gap-4 md:grid-cols-3">
    ${formats
      .map(
        (
          item,
        ) => `<div class="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <h3 class="font-semibold text-slate-100">${escapeHtml(item.format)}</h3>
          <div class="mt-4 space-y-2 text-sm text-slate-400">
            <div class="flex justify-between"><span>Files</span><span class="font-medium text-slate-100">${formatNumber(item.files)}</span></div>
            <div class="flex justify-between"><span>Clones</span><span class="font-medium text-slate-100">${formatNumber(item.clones)}</span></div>
            <div class="flex justify-between"><span>Duplicated lines</span><span class="font-medium text-slate-100">${formatNumber(item.duplicatedLines)}</span></div>
            <div class="flex justify-between"><span>Rate</span><span class="font-medium text-slate-100">${formatPercent(item.percentage)}</span></div>
          </div>
        </div>`,
      )
      .join("")}
  </div>`;
}

async function buildHtml() {
  const [coverage, crap, duplication] = await Promise.all([
    collectCoverage(),
    collectCrap(),
    collectDuplication(),
  ]);

  const generatedAt = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>slopcad Quality Report</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div class="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.18),_transparent_28rem),radial-gradient(circle_at_top_right,_rgba(244,63,94,0.10),_transparent_24rem),linear-gradient(180deg,_#020617_0,_#0f172a_28rem,_#020617_100%)]">
      <header class="mx-auto max-w-7xl px-6 py-10 text-white lg:px-8">
        <div class="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div class="text-sm font-semibold uppercase tracking-[0.3em] text-blue-200">slopcad</div>
            <h1 class="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Quality report</h1>
            <p class="mt-4 max-w-2xl text-base leading-7 text-slate-300">A focused snapshot of coverage, change-risk hotspots, and duplicated code. Use this as a triage map, then open the detailed reports when a section needs deeper inspection.</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/10 p-4 text-sm text-slate-200 shadow-2xl shadow-blue-950/30 backdrop-blur">
            <div class="font-medium text-white">Generated</div>
            <div class="mt-1">${escapeHtml(generatedAt)}</div>
          </div>
        </div>
      </header>

      <main class="mx-auto max-w-7xl px-6 pb-16 lg:px-8">
        <nav class="mb-6 flex flex-wrap gap-2 rounded-2xl border border-slate-700 bg-slate-900/80 p-2 shadow-xl shadow-slate-950/40 backdrop-blur">
          <a class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white" href="#overview">Overview</a>
          <a class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white" href="#coverage">Coverage</a>
          <a class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white" href="#crap">CRAP</a>
          <a class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white" href="#duplication">Duplication</a>
        </nav>

        <section id="overview" class="rounded-3xl border border-slate-800 bg-slate-950/80 p-5 shadow-2xl shadow-slate-950/40 sm:p-8">
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            ${metricCard("Line coverage", formatPercent(coverage.global.lines.pct), `${coverage.global.lines.covered}/${coverage.global.lines.total} covered lines`, toneForCoverage(coverage.global.lines.pct))}
            ${metricCard("Branch coverage", formatPercent(coverage.global.branches.pct), `${coverage.global.branches.covered}/${coverage.global.branches.total} covered branches`, toneForCoverage(coverage.global.branches.pct))}
            ${metricCard("High-risk functions", formatNumber(crap.highRisk), "CRAP score at or above 30", toneForCrap(crap.highRisk))}
            ${metricCard("Duplicated lines", formatPercent(duplication.totals.percentage), `${formatNumber(duplication.totals.duplicatedLines)} duplicated lines`, toneForDuplication(duplication.totals.percentage))}
          </div>

          ${sectionHeader(
            "coverage",
            "Coverage",
            "Lowest coverage files",
            "Prioritize large files with low line coverage. These are usually the fastest way to reduce blind spots without chasing tiny utilities.",
            reportInputs.coverage.map((item) => ({
              label: `${item.name} detail`,
              href: item.htmlPath,
            })),
          )}
          <div class="mt-6 space-y-6">
            ${renderPackageCoverage(coverage.packages)}
            ${coverageTable(coverage.offenders)}
          </div>

          ${sectionHeader(
            "crap",
            "Change risk",
            "Highest CRAP functions",
            "CRAP combines cyclomatic complexity with missing coverage. Scores at or above 30 are the clearest refactor-or-test candidates.",
            reportInputs.crap.map((item) => ({
              label: `${item.name} detail`,
              href: item.htmlPath,
            })),
          )}
          <div class="mt-6 space-y-6">
            ${renderCrapPackages(crap.packages)}
            ${crapTable(crap.offenders)}
          </div>

          ${sectionHeader("duplication", "Duplication", "Largest duplicate-code offenders", "This section is collection-only today. Use it to spot repeated blocks and reusable-component opportunities.", [{ label: "jscpd detail", href: reportInputs.duplication.htmlPath }])}
          <div class="mt-6 space-y-6">
            ${renderDuplicationFormats(duplication.formats)}
            ${duplicationTable(duplication.offenders)}
            <div>
              <h3 class="mb-3 text-lg font-semibold text-slate-100">Largest clone pairs</h3>
              ${cloneCards(duplication.cloneOffenders)}
            </div>
          </div>
        </section>
      </main>
    </div>
  </body>
</html>`;
}

await mkdir(outputDir, { recursive: true });
await writeFile(absoluteOutputPath, await buildHtml(), "utf8");
console.log(`Wrote ${path.relative(repoRoot, absoluteOutputPath)}`);
