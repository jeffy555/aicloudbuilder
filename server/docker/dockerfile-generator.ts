import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper function to repair JSON (enhanced version)
function repairJson(jsonText: string): string {
  let repaired = jsonText.trim();
  
  // Remove markdown code blocks if still present
  repaired = repaired.replace(/^```json\s*\n?/i, '');
  repaired = repaired.replace(/\n?```\s*$/i, '');
  repaired = repaired.replace(/^```\s*\n?/i, '');
  
  // Remove trailing commas before closing braces/brackets
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  repaired = repaired.replace(/,(\s*\n\s*[}\]])/g, '$1');
  
  // Remove comments
  repaired = repaired.replace(/\/\/.*$/gm, '');
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // CRITICAL: Fix control characters in string values
  // We need to properly escape newlines, tabs, etc. in JSON string values
  // Strategy: Find all string values (between quotes) and escape control chars
  let result = '';
  let inString = false;
  let escapeNext = false;
  let stringStart = -1;
  
  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    
    if (escapeNext) {
      // Previous char was backslash - this character is escaped
      // Preserve escape sequences as-is (they're already escaped in the source)
      result += char;
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      // Found a backslash - next character will be escaped
      escapeNext = true;
      result += char;
      continue;
    }
    
    if (char === '"') {
      // This is a quote delimiter (not escaped since escapeNext is false here)
      if (!inString) {
        // Starting a string
        inString = true;
        stringStart = result.length;
        result += char;
      } else {
        // Ending a string
        inString = false;
        result += char;
      }
      continue;
    }
    
    if (inString) {
      // We're inside a string value - escape control characters that aren't already escaped
      if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else if (char === '\f') {
        result += '\\f';
      } else if (char === '\b') {
        result += '\\b';
      } else if (/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(char)) {
        // Remove other control characters (but keep \n, \r, \t, \f, \b which we handled above)
        continue;
      } else {
        result += char;
      }
    } else {
      // Outside string - keep as is
      result += char;
    }
  }
  
  repaired = result;
  
  // Fix unquoted keys (more robust pattern)
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, (match, prefix, key) => {
    // Only fix if not already quoted
    if (!match.includes('"')) {
      return `${prefix}"${key}":`;
    }
    return match;
  });
  
  // Fix single quotes to double quotes (but be careful with already escaped quotes)
  // Only replace single quotes that are not already escaped and not inside strings
  // This is tricky - we'll do it more carefully
  repaired = repaired.replace(/(?<!\\)'(?![^"]*":)/g, '"');
  
  // Try to extract JSON object if wrapped in text
  const jsonMatch = repaired.match(/\{[\s\S]*\}/);
  if (jsonMatch && jsonMatch[0] !== repaired) {
    repaired = jsonMatch[0];
  }
  
  return repaired.trim();
}

const SCOPE_VIOLATION_RULES = [
  { keyword: "Terraform", pattern: /terraform/i },
  { keyword: "Kubernetes", pattern: /kubernetes/i },
  { keyword: "ScoreMe", pattern: /scoreme/i },
  { keyword: "ArchMe", pattern: /archme/i },
  { keyword: "Automation scripts", pattern: /automation script(s)?/i },
  { keyword: "Weather/trivia", pattern: /\b(weather|trivia)\b/i },
];

const MAX_SCOPE_RETRIES = 1;

function detectScopeViolations(text: string): string[] {
  const violations = new Set<string>();
  for (const rule of SCOPE_VIOLATION_RULES) {
    if (rule.pattern.test(text)) {
      violations.add(rule.keyword);
    }
  }
  return Array.from(violations);
}

export interface DockerRequirements {
  baseImage?: string;
  runtime?: string;
  dependencies?: string[];
  buildCommands?: string[];
  envVars?: Record<string, string>;
  ports?: number[];
  workingDir?: string;
  healthCheck?: string;
  multiStage?: boolean;
}

export interface ExistingDockerfilePayload {
  path: string;
  content: string;
}

export interface DockerfileResult {
  files: Array<{
    path: string;
    content: string;
  }>;
}

/**
 * Generate optimized and secure Dockerfile based on requirements
 */
export async function generateDockerfile(
  requirements: string | DockerRequirements,
  existingDockerfile?: ExistingDockerfilePayload,
  attempt = 0
): Promise<DockerfileResult> {
  console.log('\n🐳 ========== DOCKERFILE GENERATION ==========');
  
  // Convert string requirements to structured format if needed
  let requirementsText: string;
  if (typeof requirements === 'string') {
    requirementsText = requirements;
  } else {
    // Format structured requirements
    requirementsText = `Base Image: ${requirements.baseImage || 'Not specified'}
Runtime: ${requirements.runtime || 'Not specified'}
Dependencies: ${requirements.dependencies?.join(', ') || 'Not specified'}
Build Commands: ${requirements.buildCommands?.join(' && ') || 'Not specified'}
Environment Variables: ${JSON.stringify(requirements.envVars || {})}
Exposed Ports: ${requirements.ports?.join(', ') || 'Not specified'}
Working Directory: ${requirements.workingDir || 'Not specified'}
Health Check: ${requirements.healthCheck || 'Not specified'}
Multi-Stage Build: ${requirements.multiStage ? 'Yes' : 'No'}`;
  }
  if (existingDockerfile) {
    requirementsText += `\nExisting Dockerfile path: ${existingDockerfile.path}`;
  }

  const systemPrompt = `You are an expert Docker engineer specializing in creating optimized, secure, and production-ready Dockerfiles.

Your task is to generate Dockerfiles that follow industry best practices for:
1. Security (non-root user, minimal attack surface, no secrets in layers)
2. Optimization (multi-stage builds, layer caching, minimal image size)
3. Maintainability (clear structure, proper comments, version pinning)
4. Production readiness (health checks, proper error handling)

CRITICAL REQUIREMENTS:
- Use multi-stage builds for optimization
- Use minimal base images (alpine, slim variants when possible)
- Run as non-root user (create dedicated user)
- Pin specific image versions (never use 'latest' tag)
- Optimize layer caching (order commands from least to most frequently changing)
- Add .dockerignore file to exclude unnecessary files
- Add HEALTHCHECK instruction when appropriate
- Set proper working directory
- Minimize image size (remove package managers, clean cache)
- Use build args for secrets (never hardcode)
- Follow security best practices
- Stay strictly within Docker scope: do not mention Terraform, Kubernetes, AutomationScripts, ScoreMe, ArchMe, or unrelated topics such as weather/trivia.

Generate:
1. Dockerfile - Optimized and secure
2. .dockerignore - Exclude unnecessary files
3. Optional: docker-compose.yml if multi-container setup is needed

Return ONLY valid JSON in this exact format:
{
  "files": [
    {
      "path": "Dockerfile",
      "content": "..."
    },
    {
      "path": ".dockerignore",
      "content": "..."
    }
  ]
}`;

  const existingDockerfileContext = existingDockerfile
    ? `Existing Dockerfile path: ${existingDockerfile.path}
Existing Dockerfile content:
\`\`\`dockerfile
${existingDockerfile.content}
\`\`\`
Please validate the current file, apply best practices, and produce an improved Dockerfile or highlight exactly what should change.`
    : "There is no existing Dockerfile; generate a new file from the repository scan.";

  const userPrompt = `Generate an optimized and secure Dockerfile based on these requirements:

${requirementsText}

Requirements:
1. Use multi-stage builds for optimization
2. Use minimal base images (alpine/slim variants)
3. Run as non-root user
4. Optimize layer caching
5. Add .dockerignore file
6. Add health checks if applicable
7. Set proper working directory
8. Use specific image tags (not 'latest')
9. Minimize image size
10. Follow security best practices

${existingDockerfileContext}

Generate Dockerfile and .dockerignore files.`;

  try {
    console.log('🤖 Calling OpenAI API...');
    
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const scopeRetryReminder =
      attempt > 0
        ? "Previous response included unrelated module references. This request is strictly for Dockerfile generation—do not mention Terraform, Kubernetes, ScoreMe, ArchMe, automation scripts, weather, hobby topics, or other unrelated content."
        : null;

    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...(scopeRetryReminder ? [{
        role: 'system',
        content: scopeRetryReminder
      }] : []),
      {
        role: 'user',
        content: userPrompt
      }
    ];
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.3,
      max_tokens: 4000,
    });

    const response = completion.choices[0]?.message?.content?.trim() || '';
    
    if (!response) {
      throw new Error('Empty response from OpenAI API');
    }

    const scopeViolations = detectScopeViolations(response);
    if (scopeViolations.length > 0) {
      console.warn(`🚫 Docker scope violation detected: ${scopeViolations.join(", ")}`);
      if (attempt >= MAX_SCOPE_RETRIES) {
        throw new Error(
          `Docker generation failed because the AI response mentioned ${scopeViolations.join(", ")}. Please retry with a Docker-specific repository.`
        );
      }
      console.log("   Retrying with stricter scope enforcement...");
      return generateDockerfile(requirements, existingDockerfile, attempt + 1);
    }
    
    console.log(`📥 Received response from OpenAI (${response.length} chars)`);
    console.log(`📝 Full response (first 1000 chars):\n${response.substring(0, 1000)}`);
    if (response.length > 1000) {
      console.log(`   ... (${response.length - 1000} more chars)`);
    }

    // Parse JSON response
    let jsonText = response.trim();
    
    // Remove markdown code blocks if present
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
      console.log('   ✅ Removed ```json markdown wrapper');
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
      console.log('   ✅ Removed ``` markdown wrapper');
    }

    // Try to extract JSON object if response contains text before/after JSON
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch && jsonMatch[0] !== jsonText) {
      console.log('   ⚠️  Found JSON object within larger text, extracting...');
      jsonText = jsonMatch[0];
    }

    // Try to parse JSON
    let result: DockerfileResult;
    try {
      result = JSON.parse(jsonText);
      console.log('✅ Successfully parsed JSON response');
    } catch (parseError: any) {
      const errorPos = parseError.message.match(/position (\d+)/)?.[1] || 'unknown';
      console.error('\n❌ ========== JSON PARSE ERROR ==========');
      console.error(`   Parse error: ${parseError.message}`);
      console.error(`   Error at position: ${errorPos}`);
      console.error(`   JSON text length: ${jsonText.length}`);
      
      // Show context around the error position
      if (errorPos !== 'unknown') {
        const pos = parseInt(errorPos);
        const start = Math.max(0, pos - 150);
        const end = Math.min(jsonText.length, pos + 150);
        console.error(`   Context around error (chars ${start}-${end}):`);
        const context = jsonText.substring(start, end);
        const relativePos = pos - start;
        console.error(`   ${context}`);
        console.error(`   ${' '.repeat(relativePos)}^ (error here)`);
      }
      
      console.error(`   Full JSON text (first 3000 chars):\n${jsonText.substring(0, 3000)}`);
      if (jsonText.length > 3000) {
        console.error(`   ... (${jsonText.length - 3000} more chars)`);
      }
      console.error('==========================================\n');
      
      // Try to repair JSON
      console.log('🔧 Attempting to repair JSON...');
      const repaired = repairJson(jsonText);
      console.log(`   Repaired JSON length: ${repaired.length}`);
      console.log(`   Repaired JSON preview: ${repaired.substring(0, 500)}`);
      
      try {
        result = JSON.parse(repaired);
        console.log('✅ Successfully parsed repaired JSON');
      } catch (repairError: any) {
        console.error('\n❌ ========== REPAIR ALSO FAILED ==========');
        console.error(`   Repair error: ${repairError.message}`);
        const repairErrorPos = repairError.message.match(/position (\d+)/)?.[1] || 'unknown';
        console.error(`   Repair error at position: ${repairErrorPos}`);
        
        // Show context around repair error
        if (repairErrorPos !== 'unknown') {
          const pos = parseInt(repairErrorPos);
          const start = Math.max(0, pos - 100);
          const end = Math.min(repaired.length, pos + 100);
          console.error(`   Context around repair error (chars ${start}-${end}):`);
          console.error(`   ${repaired.substring(start, end)}`);
          console.error(`   ${' '.repeat(Math.min(100, pos - start))}^`);
        }
        
        console.error(`   Repaired JSON (first 3000 chars):\n${repaired.substring(0, 3000)}`);
        if (repaired.length > 3000) {
          console.error(`   ... (${repaired.length - 3000} more chars)`);
        }
        console.error('==========================================\n');
        
        // Strategy 2: More aggressive control character removal
        console.log('🔧 Attempting Strategy 2: Aggressive control character removal...');
        let repaired2 = jsonText.trim();
        // Remove ALL control characters (except properly escaped ones)
        repaired2 = repaired2.replace(/[\x00-\x1F\x7F]/g, (char) => {
          const code = char.charCodeAt(0);
          if (code === 0x09) return ' '; // tab -> space
          if (code === 0x0A) return ' '; // newline -> space (in non-string context)
          if (code === 0x0D) return ''; // carriage return -> remove
          return ''; // remove other control chars
        });
        repaired2 = repairJson(repaired2);
        
        try {
          result = JSON.parse(repaired2);
          console.log('✅ Successfully parsed JSON after aggressive control character removal');
        } catch (repairError2: any) {
          console.warn(`   Strategy 2 failed: ${repairError2.message}`);
          
          // Strategy 3: Extract Dockerfile content directly from response using multiple patterns
          console.log('🔧 Attempting Strategy 3: Extract Dockerfile content directly from response...');
          
          // Try multiple patterns to find Dockerfile content
          let dockerfileContent = '';
          const patterns = [
            /"content"\s*:\s*"FROM[\s\S]*?"/i,  // JSON format: "content": "FROM..."
            /(?:FROM|# Dockerfile)[\s\S]*?(?=\n```|\n\{|```json|"path"|$)/i,  // Direct Dockerfile content
            /```dockerfile\s*\n([\s\S]*?)\n```/i,        // Markdown code block
            /```\s*\n([\s\S]*?FROM[\s\S]*?)\n```/i       // Generic code block with FROM
          ];
          
          for (const pattern of patterns) {
            const match = response.match(pattern);
            if (match) {
              dockerfileContent = match[1] || match[0];
              // If it's from JSON format, extract just the content part
              if (dockerfileContent.includes('"content"')) {
                const contentMatch = dockerfileContent.match(/"content"\s*:\s*"([\s\S]*?)"/i);
                if (contentMatch) {
                  dockerfileContent = contentMatch[1];
                  // Unescape JSON escape sequences
                  dockerfileContent = dockerfileContent
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\t/g, '\t')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\');
                }
              }
              // Clean up markdown
              dockerfileContent = dockerfileContent.replace(/^```dockerfile\s*\n?/i, '');
              dockerfileContent = dockerfileContent.replace(/^```\s*\n?/, '');
              dockerfileContent = dockerfileContent.replace(/\n?```\s*$/, '');
              dockerfileContent = dockerfileContent.trim();
              
              if (dockerfileContent && dockerfileContent.toUpperCase().includes('FROM')) {
                console.log(`   ✅ Found Dockerfile content using pattern`);
                break;
              }
            }
          }
          
          if (dockerfileContent && dockerfileContent.toUpperCase().includes('FROM')) {
            console.log(`   ✅ Extracted Dockerfile content (${dockerfileContent.length} chars)`);
            
            // Try to extract .dockerignore if present
            let dockerignoreContent = '# Exclude unnecessary files\nnode_modules\n.git\n.env\n*.log\n';
            const dockerignorePatterns = [
              /"path"\s*:\s*"[^"]*dockerignore[^"]*"[\s\S]*?"content"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/i,
              /\.dockerignore[\s\S]*?```\s*\n([\s\S]*?)\n```/i
            ];
            
            for (const pattern of dockerignorePatterns) {
              const match = response.match(pattern);
              if (match && match[1]) {
                dockerignoreContent = match[1]
                  .replace(/\\n/g, '\n')
                  .replace(/\\r/g, '\r')
                  .replace(/\\t/g, '\t')
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\')
                  .trim();
                console.log('   ✅ Extracted .dockerignore content');
                break;
              }
            }
            
            result = {
              files: [
                { path: 'Dockerfile', content: dockerfileContent },
                { path: '.dockerignore', content: dockerignoreContent }
              ]
            };
            console.log('   ✅ Created result from extracted content (Strategy 3)');
          } else {
            throw new Error(`All repair strategies failed. Original: ${parseError.message}. Repair 1: ${repairError.message}. Repair 2: ${repairError2.message}. Could not extract Dockerfile content from response.`);
          }
        }
      }
    }

    // Validate result structure
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid response format: result is not an object');
    }
    
    if (!result.files || !Array.isArray(result.files)) {
      throw new Error('Invalid response format: missing files array');
    }
    
    if (result.files.length === 0) {
      throw new Error('Invalid response format: files array is empty');
    }

    // Ensure Dockerfile is present
    const hasDockerfile = result.files.some(f => f.path === 'Dockerfile' || f.path.toLowerCase() === 'dockerfile');
    if (!hasDockerfile) {
      throw new Error('Dockerfile not found in generated files. Generated files: ' + result.files.map(f => f.path).join(', '));
    }
    
    // Validate file content
    for (const file of result.files) {
      if (!file.path || !file.content) {
        throw new Error(`Invalid file format: missing path or content for file ${JSON.stringify(file)}`);
      }
      if (file.content.trim().length === 0) {
        throw new Error(`Invalid file format: empty content for file ${file.path}`);
      }
    }

    console.log(`✅ Generated ${result.files.length} file(s):`);
    result.files.forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);
    });

    return result;
  } catch (error: any) {
    console.error('\n❌ ========== DOCKERFILE GENERATOR ERROR ==========');
    console.error('Error type:', error?.constructor?.name || typeof error);
    console.error('Error message:', error?.message || String(error));
    console.error('Error code:', error?.code);
    console.error('Error name:', error?.name);
    if (error?.stack) {
      console.error('Error stack:');
      console.error(error.stack);
    }
    console.error('==========================================\n');
    
    // Re-throw with more context
    if (error?.message?.includes('API key')) {
      throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.');
    } else if (error?.message?.includes('rate limit') || error?.code === 'rate_limit_exceeded') {
      throw new Error('OpenAI API rate limit exceeded. Please wait a moment and try again.');
    } else {
      throw new Error(`Failed to generate Dockerfile: ${error.message}`);
    }
  }
}

