/**
 * Checkov Native Fetcher
 *
 * Phase 3: Fetches Checkov check definitions from GitHub, parses Python source
 * to extract check metadata, and infers Terraform fix snippets.
 *
 * All public methods degrade gracefully — failures return null, never throw.
 * Results are cached via checkov-cache.ts to minimize GitHub API calls.
 */

import { checkovCache, type InferredRemediation } from './checkov-cache';

const GITHUB_SEARCH_URL = 'https://api.github.com/search/code';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/bridgecrewio/checkov/master';
const CHECKOV_REPO = 'bridgecrewio/checkov';
const CHECKOV_TERRAFORM_PATH = 'checkov/terraform/checks';

// Rate limiting: 30 req/min with token, 10 without
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = process.env.GITHUB_TOKEN ? 30 : 10;

export interface ParsedCheck {
  id: string;
  name: string;
  supportedResources: string[];
  guidelineUrl: string | null;
  attributes: string[];
  scanLogic: string;
}

class CheckovFetcher {
  private requestTimestamps: number[] = [];

  /**
   * Main entry: get inferred remediation for a check + resource type.
   * Returns null on any failure — never throws.
   */
  async fetchRemediation(checkId: string, resourceType: string): Promise<InferredRemediation | null> {
    try {
      // 1. Parsed cache hit — return immediately
      const cached = await checkovCache.getParsed(checkId, resourceType);
      if (cached) {
        return cached.inferredRemediation;
      }

      // 2. Get source (from cache or GitHub)
      const source = await this.getSource(checkId);
      if (!source) return null;

      // 3. Parse Python → extract check definition
      const parsed = this.parseCheckSource(source.content, checkId);
      if (!parsed) {
        // Cache negative result to avoid retrying unparseable files
        await checkovCache.setParsed(checkId, resourceType, {
          checkId,
          resourceType,
          checkName: '',
          supportedResources: [],
          guidelineUrl: null,
          inferredRemediation: null,
        });
        return null;
      }

      // 4. Infer remediation from parsed check
      const inferred = this.inferRemediation(parsed, resourceType);

      // 5. Cache parsed result
      await checkovCache.setParsed(checkId, resourceType, {
        checkId,
        resourceType,
        checkName: parsed.name,
        supportedResources: parsed.supportedResources,
        guidelineUrl: parsed.guidelineUrl,
        inferredRemediation: inferred,
      });

      return inferred;
    } catch (error: any) {
      console.warn(`⚠️  CheckovFetcher failed for ${checkId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Retrieve source — from cache or fetched from GitHub
   */
  private async getSource(checkId: string): Promise<{ content: string; filePath: string } | null> {
    const cachedSource = await checkovCache.getSource(checkId);
    if (cachedSource) {
      return { content: cachedSource.content, filePath: cachedSource.filePath };
    }

    const filePath = await this.searchGitHub(checkId);
    if (!filePath) return null;

    const content = await this.fetchRawFile(filePath);
    if (!content) return null;

    await checkovCache.setSource(checkId, filePath, content);
    return { content, filePath };
  }

  /**
   * Search GitHub for the file containing a check ID
   */
  private async searchGitHub(checkId: string): Promise<string | null> {
    try {
      await this.waitForRateLimit();

      const query = `${checkId}+repo:${CHECKOV_REPO}+path:${CHECKOV_TERRAFORM_PATH}`;
      const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(query)}`;
      const headers = this.buildHeaders();

      const response = await fetch(url, { headers });
      this.recordRequest();

      if (!response.ok) {
        console.warn(`⚠️  GitHub search returned ${response.status} for ${checkId}`);
        return null;
      }

      const data = await response.json() as { items?: Array<{ path: string }> };
      return data.items?.[0]?.path || null;
    } catch (error: any) {
      console.warn(`⚠️  GitHub search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch raw file content from GitHub
   */
  private async fetchRawFile(filePath: string): Promise<string | null> {
    try {
      await this.waitForRateLimit();

      const url = `${GITHUB_RAW_BASE}/${filePath}`;
      const headers = this.buildHeaders();

      const response = await fetch(url, { headers });
      this.recordRequest();

      if (!response.ok) {
        console.warn(`⚠️  GitHub raw fetch returned ${response.status} for ${filePath}`);
        return null;
      }

      return await response.text();
    } catch (error: any) {
      console.warn(`⚠️  GitHub raw fetch failed: ${error.message}`);
      return null;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AICloudBuilder-CheckovFetcher',
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  // --- Rate limiting (sliding window) ---

  private recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      ts => now - ts < RATE_LIMIT_WINDOW_MS
    );

    if (this.requestTimestamps.length >= RATE_LIMIT_MAX) {
      const oldest = this.requestTimestamps[0];
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 100;
      if (waitMs > 0) {
        console.log(`⏳ GitHub rate limit approaching — waiting ${waitMs}ms`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        this.requestTimestamps = this.requestTimestamps.filter(
          ts => Date.now() - ts < RATE_LIMIT_WINDOW_MS
        );
      }
    }
  }

  // --- Python source parsing ---

  /**
   * Parse a Checkov Python check file and extract metadata.
   * Returns null if the source cannot be parsed or doesn't match the expected check ID.
   */
  parseCheckSource(source: string, expectedCheckId?: string): ParsedCheck | null {
    if (!source || source.trim().length === 0) return null;

    // Extract check ID: id = "CKV_AZURE_59"
    const idMatch = source.match(/(?:^|\s)id\s*=\s*["']([^"']+)["']/m);
    if (!idMatch) return null;
    const checkId = idMatch[1];

    // Verify expected check ID if provided
    if (expectedCheckId && checkId !== expectedCheckId) return null;

    // Extract name: name = "Ensure ..."
    const nameMatch = source.match(/name\s*=\s*["']([^"']+)["']/);
    const name = nameMatch?.[1] || '';

    // Extract supported resources: supported_resources = ['azurerm_storage_account']
    const supportedResources: string[] = [];
    const resourcesMatch = source.match(/supported_resources\s*=\s*\[([^\]]+)\]/);
    if (resourcesMatch) {
      for (const m of resourcesMatch[1].matchAll(/["']([^"']+)["']/g)) {
        supportedResources.push(m[1]);
      }
    }

    // Extract first guideline URL from source
    const urlMatch = source.match(/https?:\/\/[^\s"')\]]+/);
    const guidelineUrl = urlMatch?.[0] || null;

    // Extract attributes accessed via conf.get("attr") or conf["attr"]
    const attributes: string[] = [];
    const attrRegex = /conf(?:\.get\(\s*["'](\w+)["']|\[["'](\w+)["']\])/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(source)) !== null) {
      const attr = attrMatch[1] || attrMatch[2];
      if (attr && !attributes.includes(attr)) {
        attributes.push(attr);
      }
    }

    // Extract scan_resource_conf method body
    const scanMatch = source.match(/def\s+scan_resource_conf[^:]*:([\s\S]*?)(?=\n    def |\nclass |$)/);
    const scanLogic = scanMatch?.[1] || '';

    return { id: checkId, name, supportedResources, guidelineUrl, attributes, scanLogic };
  }

  /**
   * Infer a Terraform fix from parsed check metadata.
   * Returns null if no remediation can be inferred (e.g. resource type not supported,
   * or scan logic patterns not recognized).
   */
  inferRemediation(parsed: ParsedCheck, resourceType: string): InferredRemediation | null {
    if (parsed.attributes.length === 0) return null;
    if (!parsed.supportedResources.includes(resourceType)) return null;

    for (const attr of parsed.attributes) {
      const result = this.inferAttributeValue(attr, parsed.scanLogic);
      if (result) return result;
    }

    return null;
  }

  /**
   * Infer the expected value for a single attribute from scan logic patterns.
   *
   * Confidence tiers:
   *   0.75 — simple boolean (Pattern A: false, Pattern B: true)
   *   0.70 — string value   (Pattern C)
   *   0.65 — exclusion list (Pattern D)
   */
  private inferAttributeValue(attributeName: string, scanLogic: string): InferredRemediation | null {
    // Find local variable assigned from conf.get("attributeName") or conf["attributeName"]
    const assignRegex = new RegExp(
      `(\\w+)\\s*=\\s*conf(?:\\.get\\(\\s*["']${attributeName}["']|\\[["']${attributeName}["']\\])`,
      'm'
    );
    const assignMatch = scanLogic.match(assignRegex);
    const localVar = assignMatch?.[1];

    // Build search targets: local variable (word-bounded) and direct conf access
    const targets: string[] = [];
    if (localVar) {
      targets.push(`\\b${localVar}\\b`);
    }
    targets.push(
      `conf(?:\\.get\\(\\s*["']${attributeName}["']|\\[["']${attributeName}["']\\])`
    );

    // Pattern A: boolean false
    for (const target of targets) {
      const falsePatterns = [
        new RegExp(`${target}[^\\n]*==\\s*\\[\\s*False\\s*\\]`),
        new RegExp(`${target}[^\\n]*\\bis\\s+False`),
        new RegExp(`${target}[^\\n]*==\\s*False`),
        new RegExp(`not\\s+${target}`),
      ];
      for (const pattern of falsePatterns) {
        if (pattern.test(scanLogic)) {
          return {
            attributeName,
            attributeType: 'simple',
            expectedValue: false,
            fixSnippet: `${attributeName} = false`,
            confidence: 0.75,
          };
        }
      }
    }

    // Pattern B: boolean true
    for (const target of targets) {
      const truePatterns = [
        new RegExp(`${target}[^\\n]*==\\s*\\[\\s*True\\s*\\]`),
        new RegExp(`${target}[^\\n]*\\bis\\s+True`),
        new RegExp(`${target}[^\\n]*==\\s*True`),
      ];
      for (const pattern of truePatterns) {
        if (pattern.test(scanLogic)) {
          return {
            attributeName,
            attributeType: 'simple',
            expectedValue: true,
            fixSnippet: `${attributeName} = true`,
            confidence: 0.75,
          };
        }
      }
    }

    // Pattern C: string value — e.g. == ["ZRS"]
    for (const target of targets) {
      const stringPattern = new RegExp(`${target}[^\\n]*==\\s*\\["([^"]+)"\\]`);
      const stringMatch = scanLogic.match(stringPattern);
      if (stringMatch) {
        const value = stringMatch[1].trim();
        if (value && value !== 'True' && value !== 'False' && value.length < 50) {
          return {
            attributeName,
            attributeType: 'simple',
            expectedValue: value,
            fixSnippet: `${attributeName} = "${value}"`,
            confidence: 0.70,
          };
        }
      }
    }

    // Pattern D: exclusion list — e.g. not in [...]
    for (const target of targets) {
      const exclusionPattern = new RegExp(`${target}[^\\n]*not\\s+in\\s+\\[`);
      if (exclusionPattern.test(scanLogic)) {
        return {
          attributeName,
          attributeType: 'simple',
          expectedValue: null,
          fixSnippet: `# ${attributeName} must not be in excluded values`,
          confidence: 0.65,
        };
      }
    }

    return null;
  }
}

const checkovFetcher = new CheckovFetcher();

export { checkovFetcher, CheckovFetcher };
