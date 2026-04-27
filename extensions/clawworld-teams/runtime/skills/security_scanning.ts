/**
 * Security Scanning Skill
 * Vulnerability detection and hardening for npm, secrets, Docker, and Kubernetes.
 * Produces SARIF 2.1.0-compliant reports and applies auto-fixes where safe.
 *
 * @module skills/security_scanning
 */

import fs from "fs/promises";
import path from "path";
import Joi from "joi";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("SecurityScanningSkill");

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** CVSS-aligned severity classification */
export type SecuritySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/** Category of the security finding */
export type FindingCategory =
  | "dependency-vulnerability"
  | "hardcoded-secret"
  | "dockerfile-misconfiguration"
  | "kubernetes-policy-violation"
  | "best-practice";

/** A single security finding */
export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  category: FindingCategory;
  title: string;
  description: string;
  /** File path where the issue was found */
  file: string;
  /** 1-based line number (null when not applicable) */
  line: number | null;
  /** Concrete remediation guidance */
  remediation: string;
  /** Whether this issue can be auto-fixed */
  autoFixable: boolean;
  /** The auto-fix patch if autoFixable is true */
  autoFix?: AutoFix;
  /** CVE identifiers if applicable */
  cveIds?: string[];
}

/** A patch to apply as part of an auto-fix */
export interface AutoFix {
  file: string;
  line: number | null;
  oldContent: string;
  newContent: string;
  description: string;
}

/** Result of a dependency scan */
export interface DependencyScanResult {
  scanId: string;
  packageJsonPath: string;
  findings: SecurityFinding[];
  scannedAt: string;
  packageCount: number;
  vulnerablePackageCount: number;
}

/** Result of a secret scan */
export interface SecretScanResult {
  scanId: string;
  source: string;
  findings: SecurityFinding[];
  scannedAt: string;
}

/** Result of a Dockerfile scan */
export interface DockerfileScanResult {
  scanId: string;
  dockerfilePath: string;
  findings: SecurityFinding[];
  scannedAt: string;
}

/** Result of a Kubernetes manifest scan */
export interface KubernetesScanResult {
  scanId: string;
  manifestDir: string;
  findings: SecurityFinding[];
  filesScanned: string[];
  scannedAt: string;
}

/** Combined input for generateSecurityReport() */
export type AnySecretScanResult =
  | DependencyScanResult
  | SecretScanResult
  | DockerfileScanResult
  | KubernetesScanResult;

/** SARIF 2.1.0 report structure (simplified) */
export interface SarifReport {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

export interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  artifacts?: SarifArtifact[];
}

export interface SarifTool {
  driver: {
    name: string;
    version: string;
    rules: SarifRule[];
  };
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  helpUri?: string;
  properties?: { tags: string[]; severity: string };
}

export interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note" | "none";
  message: { text: string };
  locations: SarifLocation[];
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
}

export interface SarifArtifact {
  location: { uri: string };
}

/** Outcome of applying auto-fixes */
export interface AutoFixResult {
  applied: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
  details: Array<{ file: string; description: string }>;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const scanDepsSchema = Joi.object({
  packageJsonPath: Joi.string().min(1).required(),
});

const scanSecretsSchema = Joi.object({
  code: Joi.string().min(1).required(),
  sourceName: Joi.string().default("inline"),
});

const scanDockerfileSchema = Joi.object({
  dockerfilePath: Joi.string().min(1).required(),
});

const scanK8sSchema = Joi.object({
  manifestDir: Joi.string().min(1).required(),
});

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class SecurityScanError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = "SecurityScanError";
  }
}

export class SecurityScanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityScanValidationError";
  }
}

// ---------------------------------------------------------------------------
// Known vulnerable packages (representative subset — production systems
// should integrate with OSV, Snyk, or npm audit API)
// ---------------------------------------------------------------------------

interface KnownVuln {
  package: string;
  affectedBelow: string;
  severity: SecuritySeverity;
  title: string;
  cveIds: string[];
  remediation: string;
}

const KNOWN_VULNS: KnownVuln[] = [
  {
    package: "lodash",
    affectedBelow: "4.17.21",
    severity: "HIGH",
    title: "Prototype Pollution in lodash",
    cveIds: ["CVE-2021-23337", "CVE-2020-8203"],
    remediation: "Upgrade lodash to >= 4.17.21",
  },
  {
    package: "minimist",
    affectedBelow: "1.2.6",
    severity: "CRITICAL",
    title: "Prototype Pollution in minimist",
    cveIds: ["CVE-2021-44906"],
    remediation: "Upgrade minimist to >= 1.2.6",
  },
  {
    package: "axios",
    affectedBelow: "1.6.0",
    severity: "HIGH",
    title: "Server-Side Request Forgery (SSRF) in axios",
    cveIds: ["CVE-2023-45857"],
    remediation: "Upgrade axios to >= 1.6.0",
  },
  {
    package: "semver",
    affectedBelow: "7.5.2",
    severity: "HIGH",
    title: "Regular Expression Denial of Service (ReDoS) in semver",
    cveIds: ["CVE-2022-25883"],
    remediation: "Upgrade semver to >= 7.5.2",
  },
  {
    package: "jsonwebtoken",
    affectedBelow: "9.0.0",
    severity: "HIGH",
    title: "Validation bypass in jsonwebtoken",
    cveIds: ["CVE-2022-23529"],
    remediation: "Upgrade jsonwebtoken to >= 9.0.0",
  },
];

// ---------------------------------------------------------------------------
// Secret patterns (same logic as code_review but mapped to SecurityFinding)
// ---------------------------------------------------------------------------

interface ScanPattern {
  id: string;
  pattern: RegExp;
  title: string;
  description: string;
  severity: SecuritySeverity;
  remediation: string;
}

const SCAN_SECRET_PATTERNS: ScanPattern[] = [
  {
    id: "SEC001",
    pattern: /AKIA[0-9A-Z]{16}/g,
    title: "AWS Access Key ID Detected",
    description: "An AWS Access Key ID was found hardcoded in the source.",
    severity: "CRITICAL",
    remediation:
      "Remove the key, rotate it in AWS IAM, and store it in AWS Secrets Manager or environment variables.",
  },
  {
    id: "SEC002",
    pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    title: "Hardcoded Password Detected",
    description: "A hardcoded password or secret was found in the source.",
    severity: "CRITICAL",
    remediation: "Use a secrets manager (AWS Secrets Manager, Vault, etc.) and inject at runtime.",
  },
  {
    id: "SEC003",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    title: "Private Key Material Detected",
    description: "A private key header was found embedded in the source.",
    severity: "CRITICAL",
    remediation: "Remove the key immediately, rotate it, and store it in a secrets manager.",
  },
  {
    id: "SEC004",
    pattern:
      /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]|\b[A-Za-z0-9]{32,}\b(?=.*(?:key|secret|token))/gi,
    title: "Hardcoded API Key Detected",
    description: "A likely hardcoded API key was found in the source.",
    severity: "HIGH",
    remediation: "Move the key to an environment variable and use a secrets manager.",
  },
  {
    id: "SEC005",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    title: "Hardcoded JWT Token Detected",
    description: "A JWT token was found hardcoded in the source.",
    severity: "HIGH",
    remediation: "Revoke the token and generate new ones at runtime.",
  },
  {
    id: "SEC006",
    pattern: /(?:mongodb|postgresql|mysql|redis):\/\/[^:]+:[^@]+@[^\s'"]+/gi,
    title: "Database Connection String With Credentials Detected",
    description: "A database connection string including credentials was found.",
    severity: "CRITICAL",
    remediation:
      "Store credentials separately in environment variables and assemble the connection string at runtime.",
  },
];

// ---------------------------------------------------------------------------
// Dockerfile best-practice rules
// ---------------------------------------------------------------------------

interface DockerRule {
  id: string;
  pattern: RegExp;
  title: string;
  description: string;
  severity: SecuritySeverity;
  remediation: string;
  autoFixable: boolean;
}

const DOCKERFILE_RULES: DockerRule[] = [
  {
    id: "DOCKER001",
    pattern: /^FROM\s+\S+:latest\s*$/im,
    title: 'Use of "latest" Docker tag',
    description:
      'Pinning to "latest" makes builds non-deterministic and may pull vulnerable images.',
    severity: "HIGH",
    remediation: "Pin to a specific version digest: `FROM node:20.15.0-alpine3.20`",
    autoFixable: false,
  },
  {
    id: "DOCKER002",
    pattern: /^FROM\s+(?!.*:(?!latest))\S+\s*$/im,
    title: "Untagged base image",
    description: 'No tag specified — Docker defaults to "latest".',
    severity: "HIGH",
    remediation: "Always specify a version tag for the base image.",
    autoFixable: false,
  },
  {
    id: "DOCKER003",
    pattern: /^RUN\s+apt-get\s+install(?!\s+--no-install-recommends)/im,
    title: "apt-get install without --no-install-recommends",
    description: "Installing without --no-install-recommends may pull in unexpected packages.",
    severity: "LOW",
    remediation: "Use `apt-get install --no-install-recommends`",
    autoFixable: true,
  },
  {
    id: "DOCKER004",
    pattern: /^RUN\s+.*&&\s*rm\s+-rf\s+\/var\/lib\/apt\/lists\//im,
    title: "apt cache not cleaned in single RUN layer",
    description: "Cleaning apt cache in a different layer does not reduce image size.",
    severity: "INFO",
    remediation: "Chain apt-get commands and cleanup in a single RUN instruction.",
    autoFixable: false,
  },
  {
    id: "DOCKER005",
    pattern: /^(?!.*USER\s+\w)/im,
    title: "No non-root USER instruction",
    description: "Container may run as root, increasing blast radius if compromised.",
    severity: "MEDIUM",
    remediation: "Add `USER nonroot` after setting up the application.",
    autoFixable: false,
  },
  {
    id: "DOCKER006",
    pattern: /^ENV\s+\w+=\S*(?:password|secret|key)\S*/im,
    title: "Sensitive value in ENV instruction",
    description: "Secrets set via ENV are visible in the image metadata.",
    severity: "CRITICAL",
    remediation: "Pass secrets at container runtime via `--env-file` or a secrets manager.",
    autoFixable: false,
  },
  {
    id: "DOCKER007",
    pattern: /--privileged/i,
    title: "Privileged mode enabled",
    description: "Running containers in privileged mode grants full host access.",
    severity: "CRITICAL",
    remediation: "Remove --privileged and use specific capabilities with --cap-add instead.",
    autoFixable: false,
  },
];

// ---------------------------------------------------------------------------
// Kubernetes security rules
// ---------------------------------------------------------------------------

interface K8sRule {
  id: string;
  check: (content: string) => boolean;
  title: string;
  description: string;
  severity: SecuritySeverity;
  remediation: string;
}

const K8S_RULES: K8sRule[] = [
  {
    id: "K8S001",
    check: (c) => !c.includes("runAsNonRoot: true"),
    title: "Container may run as root",
    description: "securityContext.runAsNonRoot is not set to true.",
    severity: "HIGH",
    remediation: "Set `securityContext.runAsNonRoot: true` in the container spec.",
  },
  {
    id: "K8S002",
    check: (c) => !c.includes("readOnlyRootFilesystem: true"),
    title: "Root filesystem is writable",
    description: "securityContext.readOnlyRootFilesystem is not set.",
    severity: "MEDIUM",
    remediation: "Set `securityContext.readOnlyRootFilesystem: true`.",
  },
  {
    id: "K8S003",
    check: (c) => !c.includes("allowPrivilegeEscalation: false"),
    title: "Privilege escalation not disabled",
    description: "securityContext.allowPrivilegeEscalation is not explicitly set to false.",
    severity: "HIGH",
    remediation: "Set `securityContext.allowPrivilegeEscalation: false`.",
  },
  {
    id: "K8S004",
    check: (c) => /resources:\s*\{\}/.test(c) || !c.includes("resources:"),
    title: "No resource limits defined",
    description: "Container has no CPU/memory limits — it can starve other workloads.",
    severity: "MEDIUM",
    remediation: "Define `resources.limits.cpu` and `resources.limits.memory`.",
  },
  {
    id: "K8S005",
    check: (c) => c.includes("hostNetwork: true"),
    title: "hostNetwork is enabled",
    description: "Using the host network removes network isolation.",
    severity: "HIGH",
    remediation: "Remove `hostNetwork: true` unless absolutely required.",
  },
  {
    id: "K8S006",
    check: (c) => c.includes("hostPID: true"),
    title: "hostPID is enabled",
    description:
      "Sharing the host PID namespace allows container processes to see all host processes.",
    severity: "CRITICAL",
    remediation: "Remove `hostPID: true`.",
  },
  {
    id: "K8S007",
    check: (c) => /image:\s*\S+:latest/.test(c),
    title: 'Image pinned to "latest" tag',
    description: '"latest" is a mutable tag — production deployments should pin to a digest.',
    severity: "HIGH",
    remediation: "Pin images to a specific version or digest.",
  },
];

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function generateScanId(): string {
  return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function severityToSarifLevel(s: SecuritySeverity): SarifResult["level"] {
  switch (s) {
    case "CRITICAL":
    case "HIGH":
      return "error";
    case "MEDIUM":
      return "warning";
    case "LOW":
      return "note";
    case "INFO":
      return "none";
  }
}

/** Naive semver comparison: returns true if `version` is below `threshold` */
function versionBelow(version: string, threshold: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/[^0-9.]/g, "")
      .split(".")
      .map(Number);
  const v = parse(version);
  const t = parse(threshold);
  for (let i = 0; i < Math.max(v.length, t.length); i++) {
    const vi = v[i] ?? 0;
    const ti = t[i] ?? 0;
    if (vi < ti) {
      return true;
    }
    if (vi > ti) {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SecurityScanningSkill
// ---------------------------------------------------------------------------

/**
 * SecurityScanningSkill
 *
 * Scans npm dependencies, source code, Dockerfiles, and Kubernetes manifests
 * for security issues. Produces SARIF 2.1.0 reports and applies safe
 * auto-fixes where possible.
 *
 * @example
 * ```ts
 * const scanner = new SecurityScanningSkill();
 * const depResult = await scanner.scanDependencies('./package.json');
 * const report = scanner.generateSecurityReport([depResult]);
 * console.log(JSON.stringify(report, null, 2));
 * ```
 */
export class SecurityScanningSkill {
  constructor() {
    logger.info("SecurityScanningSkill initialised");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Scans a package.json file for known vulnerable npm dependencies.
   *
   * @param packageJsonPath - Path to the package.json file
   * @returns DependencyScanResult with all findings
   * @throws {SecurityScanValidationError} on bad input
   * @throws {SecurityScanError} on file read failure
   */
  async scanDependencies(packageJsonPath: string): Promise<DependencyScanResult> {
    const { error } = scanDepsSchema.validate({ packageJsonPath });
    if (error) {
      throw new SecurityScanValidationError(error.message);
    }

    logger.info("Scanning dependencies", { packageJsonPath });

    let raw: string;
    try {
      raw = await fs.readFile(packageJsonPath, "utf-8");
    } catch (err) {
      throw new SecurityScanError(
        `Cannot read package.json at: ${packageJsonPath}`,
        err instanceof Error ? err : undefined,
      );
    }

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new SecurityScanError(`Invalid JSON in ${packageJsonPath}`);
    }

    const allDeps: Record<string, string> = {
      ...((pkg["dependencies"] as Record<string, string>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
    };

    const packageCount = Object.keys(allDeps).length;
    const findings: SecurityFinding[] = [];
    const vulnerablePackages = new Set<string>();

    for (const [pkgName, versionRange] of Object.entries(allDeps)) {
      const cleanVersion = versionRange.replace(/[^0-9.]/g, "");
      for (const vuln of KNOWN_VULNS) {
        if (vuln.package === pkgName && versionBelow(cleanVersion, vuln.affectedBelow)) {
          vulnerablePackages.add(pkgName);
          findings.push({
            id: `DEP-${vuln.cveIds[0] ?? pkgName}`,
            severity: vuln.severity,
            category: "dependency-vulnerability",
            title: vuln.title,
            description: `Package "${pkgName}@${versionRange}" is affected by ${vuln.cveIds.join(", ")}.`,
            file: packageJsonPath,
            line: null,
            remediation: vuln.remediation,
            autoFixable: true,
            autoFix: {
              file: packageJsonPath,
              line: null,
              oldContent: `"${pkgName}": "${versionRange}"`,
              newContent: `"${pkgName}": ">=${vuln.affectedBelow}"`,
              description: `Bump ${pkgName} to >= ${vuln.affectedBelow}`,
            },
            cveIds: vuln.cveIds,
          });
        }
      }
    }

    const result: DependencyScanResult = {
      scanId: generateScanId(),
      packageJsonPath,
      findings,
      scannedAt: new Date().toISOString(),
      packageCount,
      vulnerablePackageCount: vulnerablePackages.size,
    };

    logger.info("Dependency scan complete", {
      packageJsonPath,
      packageCount,
      vulnerableCount: vulnerablePackages.size,
    });

    return result;
  }

  /**
   * Scans source code for hardcoded secrets.
   *
   * @param code - Source code string to scan
   * @param sourceName - Label used in findings (defaults to 'inline')
   * @returns SecretScanResult
   * @throws {SecurityScanValidationError} on bad input
   */
  scanSecrets(code: string, sourceName = "inline"): SecretScanResult {
    const { error } = scanSecretsSchema.validate({ code, sourceName });
    if (error) {
      throw new SecurityScanValidationError(error.message);
    }

    logger.debug("Scanning for secrets", { source: sourceName });

    const lines = code.split("\n");
    const findings: SecurityFinding[] = [];

    for (const { id, pattern, title, description, severity, remediation } of SCAN_SECRET_PATTERNS) {
      lines.forEach((line, idx) => {
        const re = new RegExp(pattern.source, pattern.flags);
        if (re.test(line)) {
          findings.push({
            id: `${id}-L${idx + 1}`,
            severity,
            category: "hardcoded-secret",
            title,
            description,
            file: sourceName,
            line: idx + 1,
            remediation,
            autoFixable: false,
          });
        }
      });
    }

    logger.info("Secret scan complete", { source: sourceName, findings: findings.length });

    return {
      scanId: generateScanId(),
      source: sourceName,
      findings,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Scans a Dockerfile for security best-practice violations.
   *
   * @param dockerfilePath - Path to the Dockerfile
   * @returns DockerfileScanResult
   * @throws {SecurityScanValidationError} on bad input
   * @throws {SecurityScanError} on file read failure
   */
  async scanDockerfile(dockerfilePath: string): Promise<DockerfileScanResult> {
    const { error } = scanDockerfileSchema.validate({ dockerfilePath });
    if (error) {
      throw new SecurityScanValidationError(error.message);
    }

    logger.info("Scanning Dockerfile", { dockerfilePath });

    let content: string;
    try {
      content = await fs.readFile(dockerfilePath, "utf-8");
    } catch (err) {
      throw new SecurityScanError(
        `Cannot read Dockerfile at: ${dockerfilePath}`,
        err instanceof Error ? err : undefined,
      );
    }

    const lines = content.split("\n");
    const findings: SecurityFinding[] = [];

    for (const rule of DOCKERFILE_RULES) {
      lines.forEach((line, idx) => {
        const re = new RegExp(rule.pattern.source, rule.pattern.flags);
        if (re.test(line)) {
          const finding: SecurityFinding = {
            id: `${rule.id}-L${idx + 1}`,
            severity: rule.severity,
            category: "dockerfile-misconfiguration",
            title: rule.title,
            description: rule.description,
            file: dockerfilePath,
            line: idx + 1,
            remediation: rule.remediation,
            autoFixable: rule.autoFixable,
          };

          if (rule.autoFixable && rule.id === "DOCKER003") {
            finding.autoFix = {
              file: dockerfilePath,
              line: idx + 1,
              oldContent: line,
              newContent: line.replace(
                /apt-get install(?!\s+--no-install-recommends)/,
                "apt-get install --no-install-recommends",
              ),
              description: "Add --no-install-recommends flag",
            };
          }

          findings.push(finding);
        }
      });
    }

    logger.info("Dockerfile scan complete", { dockerfilePath, findings: findings.length });

    return {
      scanId: generateScanId(),
      dockerfilePath,
      findings,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Scans all YAML files in a directory for Kubernetes security policy violations.
   *
   * @param manifestDir - Directory containing Kubernetes YAML manifests
   * @returns KubernetesScanResult
   * @throws {SecurityScanValidationError} on bad input
   * @throws {SecurityScanError} on directory read failure
   */
  async scanKubernetesManifests(manifestDir: string): Promise<KubernetesScanResult> {
    const { error } = scanK8sSchema.validate({ manifestDir });
    if (error) {
      throw new SecurityScanValidationError(error.message);
    }

    logger.info("Scanning Kubernetes manifests", { manifestDir });

    let entries: string[];
    try {
      entries = await fs.readdir(manifestDir);
    } catch (err) {
      throw new SecurityScanError(
        `Cannot read manifest directory: ${manifestDir}`,
        err instanceof Error ? err : undefined,
      );
    }

    const yamlFiles = entries.filter((e) => e.endsWith(".yaml") || e.endsWith(".yml"));
    const filesScanned: string[] = [];
    const findings: SecurityFinding[] = [];

    for (const fileName of yamlFiles) {
      const filePath = path.join(manifestDir, fileName);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        logger.warn("Skipping unreadable manifest", { filePath });
        continue;
      }
      filesScanned.push(filePath);

      for (const rule of K8S_RULES) {
        if (rule.check(content)) {
          findings.push({
            id: `${rule.id}-${fileName}`,
            severity: rule.severity,
            category: "kubernetes-policy-violation",
            title: rule.title,
            description: rule.description,
            file: filePath,
            line: null,
            remediation: rule.remediation,
            autoFixable: false,
          });
        }
      }
    }

    logger.info("Kubernetes scan complete", {
      manifestDir,
      filesScanned: filesScanned.length,
      findings: findings.length,
    });

    return {
      scanId: generateScanId(),
      manifestDir,
      findings,
      filesScanned,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Generates a SARIF 2.1.0 report from one or more scan results.
   *
   * @param scanResults - Array of any scan result types
   * @returns SarifReport conforming to the SARIF 2.1.0 schema
   */
  generateSecurityReport(scanResults: AnySecretScanResult[]): SarifReport {
    if (!Array.isArray(scanResults)) {
      throw new SecurityScanValidationError("scanResults must be an array");
    }

    const allFindings: SecurityFinding[] = scanResults.flatMap((r) => r.findings);
    const ruleMap = new Map<string, SecurityFinding>();
    for (const f of allFindings) {
      if (!ruleMap.has(f.id.replace(/-L\d+$/, "").replace(/-[^-]+$/, ""))) {
        ruleMap.set(f.id, f);
      }
    }

    const sarifRules: SarifRule[] = Array.from(
      new Map(allFindings.map((f) => [f.id.split("-L")[0], f])).values(),
    ).map((f) => ({
      id: f.id.split("-L")[0] ?? f.id,
      name: f.title.replace(/\s+/g, ""),
      shortDescription: { text: f.description },
      properties: { tags: [f.category], severity: f.severity },
    }));

    const sarifResults: SarifResult[] = allFindings.map((f) => ({
      ruleId: f.id.split("-L")[0] ?? f.id,
      level: severityToSarifLevel(f.severity),
      message: { text: `${f.title}: ${f.description} Remediation: ${f.remediation}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            ...(f.line != null ? { region: { startLine: f.line } } : {}),
          },
        },
      ],
    }));

    const report: SarifReport = {
      $schema:
        "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "openclaw-security-scanner",
              version: "1.0.0",
              rules: sarifRules,
            },
          },
          results: sarifResults,
        },
      ],
    };

    logger.info("SARIF report generated", {
      totalFindings: allFindings.length,
      rulesCount: sarifRules.length,
    });

    return report;
  }

  /**
   * Applies all auto-fixable issues from a set of scan results to disk.
   *
   * @param issues - Array of SecurityFindings (only autoFixable ones are processed)
   * @returns AutoFixResult summary
   */
  async applyAutoFixes(issues: SecurityFinding[]): Promise<AutoFixResult> {
    if (!Array.isArray(issues)) {
      throw new SecurityScanValidationError("issues must be an array of SecurityFinding");
    }

    const result: AutoFixResult = {
      applied: 0,
      skipped: 0,
      errors: [],
      details: [],
    };

    const fixable = issues.filter((i) => i.autoFixable && i.autoFix != null);

    for (const issue of fixable) {
      const fix = issue.autoFix!;
      try {
        let content = await fs.readFile(fix.file, "utf-8");
        if (content.includes(fix.oldContent)) {
          content = content.split(fix.oldContent).join(fix.newContent);
          await fs.writeFile(fix.file, content, "utf-8");
          result.applied++;
          result.details.push({ file: fix.file, description: fix.description });
          logger.info("Auto-fix applied", { file: fix.file, description: fix.description });
        } else {
          result.skipped++;
          logger.debug("Auto-fix skipped: pattern not found", {
            file: fix.file,
            oldContent: fix.oldContent,
          });
        }
      } catch (err) {
        result.errors.push({
          file: fix.file,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.warn("Auto-fix failed", { file: fix.file, error: err });
      }
    }

    result.skipped += issues.length - fixable.length;

    logger.info("Auto-fix pass complete", {
      applied: result.applied,
      skipped: result.skipped,
      errors: result.errors.length,
    });

    return result;
  }
}
