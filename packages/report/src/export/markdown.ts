import type { Report } from '@localqa/contracts';
import type { ManifestMap } from '../artifacts/types.js';

export function renderMarkdownReport(
  report: Report,
  manifest?: ManifestMap,
): string {
  const lines: string[] = [];
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(
    report.run.status,
  );

  lines.push(`# LocalQA Test Execution Report`);
  lines.push('');

  if (!isTerminal) {
    lines.push(`> **[SNAPSHOT / PARTIAL EXPORT]**`);
    lines.push(
      `> This report was exported while the run was still in progress (\`status: ${report.run.status}\`, \`phase: ${report.run.phase}\`). Metrics and case findings represent an active point-in-time snapshot and are not final.`,
    );
    lines.push('');
  }

  // Section 1: Run Metadata
  lines.push(`## 1. Run Overview`);
  lines.push('');
  lines.push(`| Property | Value |`);
  lines.push(`| :--- | :--- |`);
  lines.push(`| **Run ID** | \`${report.run.id}\` |`);
  lines.push(`| **Project ID** | \`${report.run.projectId}\` |`);
  lines.push(`| **Target URL** | \`${report.run.targetUrl}\` |`);
  lines.push(`| **Status** | \`${report.run.status}\` |`);
  lines.push(`| **Phase** | \`${report.run.phase}\` |`);
  lines.push(`| **Completion** | \`${report.run.completion}\` |`);
  lines.push(
    `| **Termination Reason** | \`${report.run.terminationReason ?? 'none'}\` |`,
  );
  lines.push(`| **Created At** | ${report.run.createdAt} |`);
  lines.push(`| **Generated At** | ${report.generatedAt} |`);
  lines.push('');

  // Section 2: Deterministic Summary
  const s = report.summary;
  lines.push(`## 2. Summary`);
  lines.push('');
  lines.push(`| Metric | Count / Value | Description |`);
  lines.push(`| :--- | :--- | :--- |`);
  lines.push(
    `| **Planned** | ${s.planned} | Total in-scope test cases planned |`,
  );
  lines.push(
    `| **Passed** | ${s.passed} | Cases where all fixed criteria passed |`,
  );
  lines.push(
    `| **Issue Found** | ${s.issueFound} | Cases with verified failure |`,
  );
  lines.push(
    `| **Blocked** | ${s.blocked} | Cases prevented from evaluating |`,
  );
  lines.push(
    `| **Inconclusive** | ${s.inconclusive} | Cases with ambiguous or interrupted outcome |`,
  );
  lines.push(`| **Not Run** | ${s.notRun} | Cases planned but not started |`);
  lines.push(
    `| **Attempted** | ${s.attempted} | Total cases with at least one execution attempt |`,
  );
  lines.push(
    `| **Evaluated** | ${s.evaluated} | Decisive cases (passed + issueFound) |`,
  );
  lines.push(
    `| **Pass Rate** | ${s.passRate !== null ? `${(s.passRate * 100).toFixed(1)}%` : 'N/A (evaluated=0)'} | passed / evaluated |`,
  );
  lines.push(
    `| **Attempt Rate** | ${s.attemptRate !== null ? `${(s.attemptRate * 100).toFixed(1)}%` : 'N/A (planned=0)'} | attempted / planned |`,
  );
  lines.push('');

  // Section 3: Test Cases
  lines.push(`## 3. Test Cases (${report.cases.length})`);
  lines.push('');
  let caseIndex = 1;
  for (const c of report.cases) {
    const icon =
      c.outcome === 'passed'
        ? '[PASSED]'
        : c.outcome === 'issue_found'
          ? '[ISSUE FOUND]'
          : c.outcome === 'blocked'
            ? '[BLOCKED]'
            : c.outcome === 'not_run'
              ? '[NOT RUN]'
              : '[INCONCLUSIVE]';

    lines.push(`### 3.${caseIndex++} ${icon} ${c.definition.title}`);
    lines.push('');
    lines.push(`- **Case ID**: \`${c.definition.id}\``);
    lines.push(`- **Outcome**: \`${c.outcome}\``);
    lines.push(`- **Summary**: ${c.definition.summary}`);
    if (c.definition.outline && c.definition.outline.length > 0) {
      lines.push(`- **Outline**:`);
      for (const step of c.definition.outline) {
        lines.push(`  - ${step}`);
      }
    }

    if (c.verdict) {
      lines.push(`- **Verdict ID**: \`${c.verdict.id}\``);
      lines.push(`- **Criteria Results**:`);
      for (const cr of c.verdict.criterionResults) {
        lines.push(
          `  - Criterion \`${cr.criterionId}\`: **${cr.result}** (${cr.reason})`,
        );
        if (cr.evidenceRefs.length > 0) {
          lines.push(`    - Evidence:`);
          for (const ref of cr.evidenceRefs) {
            const m = manifest?.get(ref);
            if (m && m.status === 'available' && m.relativePath) {
              lines.push(
                `      - [Artifact ${ref}](${m.relativePath}) (\`${m.kind}\`, ${m.bytes} bytes)`,
              );
            } else if (m) {
              lines.push(
                `      - Artifact \`${ref}\` (${m.kind}, ${m.status}: ${m.error ?? 'omitted'})`,
              );
            } else {
              lines.push(`      - Artifact \`${ref}\``);
            }
          }
        }
      }
    } else {
      lines.push(`- **Verdict**: None (outcome: \`${c.outcome}\`)`);
    }
    lines.push('');
  }

  // Section 4: Findings & Reproductions
  lines.push(`## 4. Findings & Reproductions`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push(`No findings recorded for this run.`);
  } else {
    let findingIndex = 1;
    for (const f of report.findings) {
      lines.push(`### 4.${findingIndex++} Finding: ${f.title}`);
      lines.push('');
      lines.push(`- **Finding ID**: \`${f.id}\``);
      lines.push(`- **Status**: \`${f.status}\``);
      lines.push(`- **Severity**: \`${f.severity}\``);
      lines.push(
        `- **Expected**: ${f.expected} (Source: \`${f.expectedSource}\`)`,
      );
      lines.push(`- **Actual**: ${f.actual}`);
      if (f.reproSteps.length > 0) {
        lines.push(`- **Repro Steps**:`);
        for (const s of f.reproSteps) {
          lines.push(`  - ${s}`);
        }
      }
      if (f.reproductionRef) {
        lines.push(`- **Reproduction Ref**: \`${f.reproductionRef}\``);
      }
      if (f.evidenceRefs.length > 0) {
        lines.push(`- **Evidence**:`);
        for (const ref of f.evidenceRefs) {
          const m = manifest?.get(ref);
          if (m && m.status === 'available' && m.relativePath) {
            lines.push(
              `  - [Evidence ${ref}](${m.relativePath}) (\`${m.kind}\`)`,
            );
          } else if (m) {
            lines.push(
              `  - Evidence \`${ref}\` (${m.status}: ${m.error ?? 'omitted'})`,
            );
          } else {
            lines.push(`  - Evidence \`${ref}\``);
          }
        }
      }
      lines.push('');
    }
  }
  lines.push('');

  // Section 5: Model Usage
  lines.push(`## 5. Model Usage`);
  lines.push('');
  if (report.modelUsage.length === 0) {
    lines.push(`No external or stub model calls were recorded.`);
  } else {
    lines.push(
      `| Profile ID | Configured Model | Reported Model | Requests | Input Tokens | Output Tokens | Usage Source |`,
    );
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const u of report.modelUsage) {
      lines.push(
        `| \`${u.profileId}\` | \`${u.configuredModelId}\` | \`${u.reportedModelId ?? 'same'}\` | ${u.requests} | ${u.inputTokens ?? 0} | ${u.outputTokens ?? 0} | \`${u.usageSource}\` |`,
      );
    }
  }
  lines.push('');

  // Section 6: Coverage Gaps
  lines.push(`## 6. Coverage Gaps`);
  lines.push('');
  for (const gap of report.coverageGaps) {
    lines.push(`- ${gap}`);
  }
  lines.push('');

  // Section 7: Warnings & Environment Notes
  lines.push(`## 7. Warnings & Environment Notes`);
  lines.push('');
  lines.push(`- **Cleanup Status**: \`${report.cleanupStatus}\``);
  if (report.warnings.length === 0) {
    lines.push(`- No warnings recorded.`);
  } else {
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
