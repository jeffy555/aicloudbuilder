/**
 * Standalone root modules must declare infrastructure with resource/data blocks,
 * not by downloading remote reusable modules (zip URLs, git URLs, etc.).
 */

const FORBIDDEN_PATTERNS: { re: RegExp; message: string }[] = [
  { re: /source\s*=\s*"https?:\/\//i, message: "remote HTTP(S) module source" },
  { re: /source\s*=\s*"git::/i, message: "git:: module source" },
  { re: /blob\.core\.windows\.net/i, message: "Azure Blob module source URL" },
  { re: /source\s*=\s*"[^"]*\.zip[^"]*"/i, message: "zip archive module source" },
];

/**
 * Returns an error message if main.tf violates standalone-root rules, else null.
 */
export function validateStandaloneRootMainTf(mainTf: string): string | null {
  const trimmed = mainTf.trim();
  if (!trimmed) {
    return "main.tf is empty.";
  }

  const hasModuleBlock = /^\s*module\s+"/m.test(trimmed) || /\nmodule\s+"/.test(trimmed);
  if (!hasModuleBlock) {
    return null;
  }

  for (const { re, message } of FORBIDDEN_PATTERNS) {
    if (re.test(trimmed)) {
      return (
        `Standalone root modules must not use ${message}. ` +
        `Define azurerm_* (or other provider) resource blocks directly in main.tf instead of calling a remote module package.`
      );
    }
  }

  return null;
}
