/**
 * Code Review Skill
 * Automated code quality analysis supporting TypeScript, Python, and Bash.
 * Uses Claude Haiku for AI-powered improvement suggestions.
 *
 * @module skills/code_review
 */

import fs from "fs/promises";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import Joi from "joi";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("CodeReviewSkill");

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Supported source languages */
export type ReviewLanguage = "typescript" | "python" | "bash" | "javascript" | "unknown";

/** Severity levels for review findings */
export type Severity = "error" | "warning" | "info" | "suggestion";

/** A single review finding */
export interface ReviewFinding {
  /** Finding severity */
  severity: Severity;
  /** File path or identifier */
  file: string;
  /** 1-based line number (null when not applicable) */
  line: number | null;
  /** Short rule or category name */
  rule: string;
  /** Human-readable description */
  message: string;
  /** Optional fix suggestion */
  suggestion?: string;
}

/** Result of a single file / code review */
export interface CodeReviewResult {
  reviewId: string;
  file: string;
  language: ReviewLanguage;
  findings: ReviewFinding[];
  summary: string;
  score: number; // 0–100
  reviewedAt: string;
}

/** Style rules map: rule name → regex pattern or description */
export type StyleRules = Record<string, string | RegExp>;

/** Aggregated pull-request review result */
export interface PullRequestReview {
  prUrl: string;
  fileReviews: CodeReviewResult[];
  overallScore: number;
  summary: string;
  reviewedAt: string;
}

/** Full review report */
export interface ReviewReport {
  reportId: string;
  generatedAt: string;
  reviews: CodeReviewResult[];
  totalFindings: number;
  findingsBySeverity: Record<Severity, number>;
  averageScore: number;
  markdown: string;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const reviewCodeSchema = Joi.object({
  filePath: Joi.string().min(1).required(),
  language: Joi.string()
    .valid("typescript", "python", "bash", "javascript", "unknown")
    .default("unknown"),
});

const checkStyleSchema = Joi.object({
  code: Joi.string().min(1).required(),
  rules: Joi.object().unknown(true).required(),
});

const detectSecretsSchema = Joi.object({
  code: Joi.string().min(1).required(),
});

const suggestImprovementsSchema = Joi.object({
  code: Joi.string().min(1).required(),
  language: Joi.string().default("unknown"),
});

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class CodeReviewError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = "CodeReviewError";
  }
}

export class CodeReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeReviewValidationError";
  }
}

// ---------------------------------------------------------------------------
// Security patterns for secret detection
// ---------------------------------------------------------------------------

interface SecretPattern {
  rule: string;
  pattern: RegExp;
  description: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    rule: "hardcoded-api-key",
    pattern:
      /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]|\b([A-Za-z0-9]{32,})\b(?=.*(?:key|secret|token))/gi,
    description: "Possible hardcoded API key detected",
  },
  {
    rule: "hardcoded-secret",
    pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    description: "Possible hardcoded secret or password detected",
  },
  {
    rule: "aws-access-key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: "AWS Access Key ID pattern detected",
  },
  {
    rule: "aws-secret-key",
    pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    description: "Possible AWS Secret Access Key detected (40-char base64)",
  },
  {
    rule: "private-key-header",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    description: "Private key material embedded in source",
  },
  {
    rule: "jwt-token",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    description: "Hardcoded JWT token detected",
  },
  {
    rule: "generic-token",
    pattern: /(?:token|auth)\s*[:=]\s*['"][A-Za-z0-9_\-.]{16,}['"]/gi,
    description: "Possible hardcoded token detected",
  },
  {
    rule: "connection-string",
    pattern: /(?:mongodb|postgresql|mysql|redis):\/\/[^:]+:[^@]+@[^\s'"]+/gi,
    description: "Database connection string with credentials detected",
  },
];

// ---------------------------------------------------------------------------
// TypeScript-specific style rules
// ---------------------------------------------------------------------------

const TS_DEFAULT_RULES: StyleRules = {
  "no-any": /:\s*any\b/,
  "no-console": /console\.(log|warn|error|debug|info)\s*\(/,
  "prefer-const": /\blet\s+[a-zA-Z_$][\w$]*\s*=/,
  "eol-newline": /[^\n]$/,
  "trailing-spaces": /[ \t]+$/m,
};

const PY_DEFAULT_RULES: StyleRules = {
  "pep8-line-length": /.{80,}/,
  "no-bare-except": /except\s*:/,
  "no-print": /\bprint\s*\(/,
  "snake-case-function": /def\s+[A-Z]/,
};

const BASH_DEFAULT_RULES: StyleRules = {
  "set-e-missing": /^(?!.*set -e)/m,
  "unquoted-variable": /\$[A-Za-z_][A-Za-z0-9_]*(?!['"}\]])/,
  "no-sudo": /\bsudo\b/,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function inferLanguage(filePath: string): ReviewLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".sh":
    case ".bash":
      return "bash";
    default:
      return "unknown";
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function scoreFromFindings(findings: ReviewFinding[]): number {
  let penalty = 0;
  for (const f of findings) {
    switch (f.severity) {
      case "error":
        penalty += 15;
        break;
      case "warning":
        penalty += 5;
        break;
      case "info":
        penalty += 1;
        break;
      case "suggestion":
        penalty += 0.5;
        break;
    }
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

// ---------------------------------------------------------------------------
// CodeReviewSkill
// ---------------------------------------------------------------------------

/**
 * CodeReviewSkill
 *
 * Provides static analysis, secret detection, style checks, and
 * AI-powered improvement suggestions for TypeScript, Python, and Bash files.
 *
 * @example
 * ```ts
 * const reviewer = new CodeReviewSkill();
 * const result = await reviewer.reviewCode('./src/index.ts', 'typescript');
 * const report = reviewer.generateReport([result]);
 * console.log(report.markdown);
 * ```
 */
export class CodeReviewSkill {
  private readonly anthropic: Anthropic;

  constructor(anthropicApiKey?: string) {
    this.anthropic = new Anthropic({
      apiKey: anthropicApiKey ?? process.env["ANTHROPIC_API_KEY"],
    });
    logger.info("CodeReviewSkill initialised");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Reads and reviews a source file at the given path.
   *
   * @param filePath - Absolute or relative path to the file
   * @param language - Source language (auto-detected from extension if 'unknown')
   * @returns Detailed CodeReviewResult
   * @throws {CodeReviewValidationError} on bad input
   * @throws {CodeReviewError} on file read failure
   */
  async reviewCode(
    filePath: string,
    language: ReviewLanguage = "unknown",
  ): Promise<CodeReviewResult> {
    const { error, value } = reviewCodeSchema.validate({ filePath, language });
    if (error) {
      throw new CodeReviewValidationError(error.message);
    }

    const { filePath: resolvedPath, language: resolvedLang } = value as {
      filePath: string;
      language: ReviewLanguage;
    };

    const detectedLang = resolvedLang === "unknown" ? inferLanguage(resolvedPath) : resolvedLang;

    let code: string;
    try {
      code = await fs.readFile(resolvedPath, "utf-8");
    } catch (err) {
      throw new CodeReviewError(
        `Failed to read file: ${resolvedPath}`,
        err instanceof Error ? err : undefined,
      );
    }

    logger.info("Reviewing file", { file: resolvedPath, language: detectedLang });

    const defaultRules =
      detectedLang === "typescript" || detectedLang === "javascript"
        ? TS_DEFAULT_RULES
        : detectedLang === "python"
          ? PY_DEFAULT_RULES
          : detectedLang === "bash"
            ? BASH_DEFAULT_RULES
            : {};

    const styleFindings = this._runStyleChecks(code, defaultRules, resolvedPath);
    const secretFindings = this._runSecretScan(code, resolvedPath);
    const findings = [...styleFindings, ...secretFindings];

    const score = scoreFromFindings(findings);

    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warnCount = findings.filter((f) => f.severity === "warning").length;

    const result: CodeReviewResult = {
      reviewId: generateId(),
      file: resolvedPath,
      language: detectedLang,
      findings,
      summary: `Found ${findings.length} issue(s): ${errorCount} error(s), ${warnCount} warning(s). Score: ${score}/100.`,
      score,
      reviewedAt: new Date().toISOString(),
    };

    logger.info("File review complete", {
      file: resolvedPath,
      score,
      totalFindings: findings.length,
    });
    return result;
  }

  /**
   * Reviews all changed files in a GitHub pull request.
   * Currently fetches PR metadata via the GitHub API.
   *
   * @param prUrl - GitHub PR URL (e.g. https://github.com/org/repo/pull/42)
   * @returns Aggregated PullRequestReview
   * @throws {CodeReviewError} on network or parsing failures
   */
  async reviewPullRequest(prUrl: string): Promise<PullRequestReview> {
    if (!prUrl || typeof prUrl !== "string" || !prUrl.startsWith("https://")) {
      throw new CodeReviewValidationError("prUrl must be a valid https:// URL");
    }

    logger.info("Reviewing pull request", { prUrl });

    // Parse GitHub PR URL: https://github.com/{owner}/{repo}/pull/{number}
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      throw new CodeReviewValidationError(`Cannot parse GitHub PR URL: ${prUrl}`);
    }

    const [, owner, repo, prNumber] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;
    const token = process.env["GITHUB_TOKEN"];

    let changedFiles: Array<{ filename: string; patch?: string }> = [];
    try {
      const res = await fetch(apiUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
      }
      changedFiles = (await res.json()) as Array<{ filename: string; patch?: string }>;
    } catch (err) {
      throw new CodeReviewError(
        `Failed to fetch PR files for ${prUrl}`,
        err instanceof Error ? err : undefined,
      );
    }

    const fileReviews: CodeReviewResult[] = [];

    for (const file of changedFiles) {
      const lang = inferLanguage(file.filename);
      const patch = file.patch ?? "";

      const defaultRules =
        lang === "typescript" || lang === "javascript"
          ? TS_DEFAULT_RULES
          : lang === "python"
            ? PY_DEFAULT_RULES
            : lang === "bash"
              ? BASH_DEFAULT_RULES
              : {};
      const styleFindings = this._runStyleChecks(patch, defaultRules, file.filename);
      const secretFindings = this._runSecretScan(patch, file.filename);
      const findings = [...styleFindings, ...secretFindings];

      fileReviews.push({
        reviewId: generateId(),
        file: file.filename,
        language: lang,
        findings,
        summary: `${findings.length} issue(s) found.`,
        score: scoreFromFindings(findings),
        reviewedAt: new Date().toISOString(),
      });
    }

    const overallScore =
      fileReviews.length > 0
        ? Math.round(fileReviews.reduce((s, r) => s + r.score, 0) / fileReviews.length)
        : 100;

    const pr: PullRequestReview = {
      prUrl,
      fileReviews,
      overallScore,
      summary: `Reviewed ${fileReviews.length} file(s). Overall score: ${overallScore}/100.`,
      reviewedAt: new Date().toISOString(),
    };

    logger.info("PR review complete", { prUrl, fileCount: fileReviews.length, overallScore });
    return pr;
  }

  /**
   * Checks a code string against a set of named rules (regex or string patterns).
   *
   * @param code - Source code to check
   * @param rules - Map of rule name → RegExp or string pattern
   * @returns Array of style findings (file labeled as 'inline')
   * @throws {CodeReviewValidationError} on bad input
   */
  checkCodeStyle(code: string, rules: StyleRules): ReviewFinding[] {
    const { error } = checkStyleSchema.validate({ code, rules });
    if (error) {
      throw new CodeReviewValidationError(error.message);
    }

    return this._runStyleChecks(code, rules, "inline");
  }

  /**
   * Scans code for hardcoded secrets, keys, and tokens.
   *
   * @param code - Source code to scan
   * @returns Array of security findings
   * @throws {CodeReviewValidationError} on bad input
   */
  detectSecurityIssues(code: string): ReviewFinding[] {
    const { error } = detectSecretsSchema.validate({ code });
    if (error) {
      throw new CodeReviewValidationError(error.message);
    }

    return this._runSecretScan(code, "inline");
  }

  /**
   * Uses Claude Haiku to generate AI-powered improvement suggestions.
   *
   * @param code - Source code to improve
   * @param language - Language hint for better suggestions
   * @returns Array of suggestion-severity findings
   * @throws {CodeReviewError} on API errors
   */
  async suggestImprovements(
    code: string,
    language: ReviewLanguage = "unknown",
  ): Promise<ReviewFinding[]> {
    const { error } = suggestImprovementsSchema.validate({ code, language });
    if (error) {
      throw new CodeReviewValidationError(error.message);
    }

    logger.debug("Requesting improvement suggestions from Claude Haiku", { language });

    const prompt = `You are a senior software engineer performing a code review.
Analyze the following ${language} code and provide improvement suggestions.
Return your response as a JSON array. Each element must have:
  - "line": line number (number or null)
  - "rule": short camelCase rule name (string)
  - "message": explanation (string)
  - "suggestion": how to fix it (string)

Code:
\`\`\`${language}
${code}
\`\`\`

Return ONLY the JSON array, no additional text.`;

    try {
      const response = await this.anthropic.messages.create({
        model: process.env["ANTHROPIC_MODEL_FAST"] ?? "anthropic/claude-haiku-3-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "[]";

      let parsed: Array<{
        line?: number | null;
        rule?: string;
        message?: string;
        suggestion?: string;
      }>;

      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn("Claude Haiku returned non-JSON, skipping suggestions", { raw });
        return [];
      }

      return parsed.map((item) => ({
        severity: "suggestion" as Severity,
        file: "inline",
        line: item.line ?? null,
        rule: item.rule ?? "ai-suggestion",
        message: item.message ?? "",
        ...(item.suggestion !== undefined ? { suggestion: item.suggestion } : {}),
      }));
    } catch (err) {
      throw new CodeReviewError(
        "Failed to get suggestions from Claude Haiku",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Builds a formatted Markdown review report from one or more review results.
   *
   * @param reviewResults - Array of CodeReviewResult objects
   * @returns Structured ReviewReport with Markdown output
   */
  generateReport(reviewResults: CodeReviewResult[]): ReviewReport {
    if (!Array.isArray(reviewResults)) {
      throw new CodeReviewValidationError("reviewResults must be an array");
    }

    const severityMap: Record<Severity, number> = {
      error: 0,
      warning: 0,
      info: 0,
      suggestion: 0,
    };

    let totalFindings = 0;
    for (const r of reviewResults) {
      for (const f of r.findings) {
        severityMap[f.severity] = (severityMap[f.severity] ?? 0) + 1;
        totalFindings++;
      }
    }

    const averageScore =
      reviewResults.length > 0
        ? Math.round(reviewResults.reduce((s, r) => s + r.score, 0) / reviewResults.length)
        : 100;

    const lines: string[] = [
      "# Code Review Report",
      "",
      `**Generated:** ${new Date().toISOString()}`,
      `**Files reviewed:** ${reviewResults.length}`,
      `**Average score:** ${averageScore}/100`,
      `**Total findings:** ${totalFindings}`,
      "",
      "## Summary",
      "",
      `| Severity | Count |`,
      `|----------|-------|`,
      `| Error | ${severityMap.error} |`,
      `| Warning | ${severityMap.warning} |`,
      `| Info | ${severityMap.info} |`,
      `| Suggestion | ${severityMap.suggestion} |`,
      "",
    ];

    for (const r of reviewResults) {
      lines.push(`## ${r.file} (${r.language}) — Score: ${r.score}/100`);
      lines.push("");
      lines.push(r.summary);
      lines.push("");

      if (r.findings.length === 0) {
        lines.push("_No issues found._");
      } else {
        lines.push("| Severity | Line | Rule | Message |");
        lines.push("|----------|------|------|---------|");
        for (const f of r.findings) {
          const lineStr = f.line != null ? String(f.line) : "-";
          lines.push(`| ${f.severity} | ${lineStr} | \`${f.rule}\` | ${f.message} |`);
        }
      }
      lines.push("");
    }

    const report: ReviewReport = {
      reportId: generateId(),
      generatedAt: new Date().toISOString(),
      reviews: reviewResults,
      totalFindings,
      findingsBySeverity: severityMap,
      averageScore,
      markdown: lines.join("\n"),
    };

    logger.info("Review report generated", {
      reportId: report.reportId,
      totalFindings,
      averageScore,
    });

    return report;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Applies regex-based style rules line by line */
  private _runStyleChecks(code: string, rules: StyleRules, file: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    const lines = code.split("\n");

    for (const [ruleName, pattern] of Object.entries(rules)) {
      const regex =
        pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags) : new RegExp(pattern);

      // eol-newline must only be checked on the final line of the file.
      // Splitting by '\n' strips the newline character from every line, so
      // applying the pattern to all lines would produce false positives on
      // every non-empty line. When the file ends with '\n', split produces an
      // empty-string last element that won't match — correct behaviour.
      const checkLines = ruleName === "eol-newline" ? [lines[lines.length - 1] ?? ""] : lines;

      checkLines.forEach((line, rawIdx) => {
        const lineNumber = ruleName === "eol-newline" ? lines.length : rawIdx + 1;
        if (regex.test(line)) {
          findings.push({
            severity: "warning",
            file,
            line: lineNumber,
            rule: ruleName,
            message: `Rule "${ruleName}" violation detected`,
          });
        }
      });
    }

    return findings;
  }

  /** Scans code for hardcoded secrets using the SECRET_PATTERNS list */
  private _runSecretScan(code: string, file: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    const lines = code.split("\n");

    for (const { rule, pattern, description } of SECRET_PATTERNS) {
      lines.forEach((line, idx) => {
        const re = new RegExp(pattern.source, pattern.flags);
        if (re.test(line)) {
          findings.push({
            severity: "error",
            file,
            line: idx + 1,
            rule,
            message: description,
            suggestion: "Move this value to an environment variable or secrets manager.",
          });
        }
      });
    }

    return findings;
  }
}
