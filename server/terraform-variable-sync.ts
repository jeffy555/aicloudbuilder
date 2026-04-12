/**
 * Ensures variables.tf and a .tfvars file exist when main.tf references var.* but the AI omitted declarations.
 * Shared by terraform-generation and MigrateOps extract.
 */
import { storage } from './storage';
import { openaiService } from './openai-service';

const MIGRATEOPS_DESCRIPTION = 'MigrateOps live Azure resource extraction';

/** When false, skip AI literal→variables/tfvars sync (default: enabled). */
const MIGRATEOPS_LITERAL_VAR_SYNC =
  process.env.MIGRATEOPS_SYNC_LITERAL_VARS !== 'false' && process.env.MIGRATEOPS_SYNC_LITERAL_VARS !== '0';

function isEmptyOrWhitespace(c: string | undefined): boolean {
  return !c || !String(c).trim().length;
}

/** True if there is no real `variable "name"` block (empty or comment-only / stub). */
function isStubOrEmptyVariablesTf(c: string | undefined): boolean {
  if (isEmptyOrWhitespace(c)) return true;
  return !/variable\s+"/.test(String(c));
}

/** True if there is no real assignment line like `name = value` (ignoring # comments). */
function isStubOrEmptyTfvars(c: string | undefined): boolean {
  if (isEmptyOrWhitespace(c)) return true;
  const nonComments = String(c)
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  return !nonComments.some((l) => /^[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(l));
}

/**
 * When main.tf has no var.* references, populate variables.tf and dev.terraform.tfvars from literals via AI.
 */
async function syncMigrateOpsVariablesFromMainLiterals(sessionId: string, mainTf: string): Promise<void> {
  if (!MIGRATEOPS_LITERAL_VAR_SYNC) {
    console.log(`   [MigrateOps] Literal variable sync disabled (MIGRATEOPS_SYNC_LITERAL_VARS=false)`);
    return;
  }
  if (!mainTf.trim() || mainTf.trim().length < 80) {
    return;
  }

  console.log(`   [MigrateOps] main.tf has no var.* — generating variables.tf + dev.terraform.tfvars from literals (AI)...`);
  const { variablesTf, tfvars } = await openaiService.generateMigrateOpsVariablesTfvarsFromMainLiterals(mainTf);

  if (!variablesTf || variablesTf.length < 30 || !/variable\s+"/.test(variablesTf)) {
    console.warn(`   ⚠️  Literal variable sync did not produce a valid variables.tf`);
    return;
  }

  const files = await storage.getFilesBySession(sessionId);
  let variablesTfFile = files.find((f) => f.fileName.toLowerCase() === 'variables.tf');
  let tfvarsFile = files.find(
    (f) =>
      f.fileName.toLowerCase() === 'dev.terraform.tfvars' || f.fileName.toLowerCase() === 'terraform.tfvars'
  );

  if (variablesTfFile) {
    await storage.updateFile(variablesTfFile.id, variablesTf);
  } else {
    variablesTfFile = await storage.createFile({
      sessionId,
      fileName: 'variables.tf',
      content: variablesTf,
    });
  }
  console.log(`   ✅ Updated variables.tf from main.tf literals (${variablesTf.length} chars)`);

  const tfvarsName = tfvarsFile?.fileName || 'dev.terraform.tfvars';
  const tfvarsContent =
    tfvars && tfvars.length > 0
      ? tfvars
      : `# dev.terraform.tfvars — add values matching variables.tf\n`;

  if (tfvarsFile) {
    await storage.updateFile(tfvarsFile.id, tfvarsContent);
  } else {
    await storage.createFile({
      sessionId,
      fileName: 'dev.terraform.tfvars',
      content: tfvarsContent,
    });
  }
  console.log(`   ✅ Updated ${tfvarsName} from literals (${tfvarsContent.length} chars)`);
}

/** AI often creates variables.tf / .tfvars as empty stubs; Terraform and reviewers expect real content. */
async function fillEmptyTerraformAuxiliaryFiles(sessionId: string): Promise<void> {
  const files = await storage.getFilesBySession(sessionId);
  const variablesTfFile = files.find((f) => f.fileName.toLowerCase() === 'variables.tf');
  const tfvarsFile = files.find(
    (f) =>
      f.fileName.toLowerCase() === 'dev.terraform.tfvars' ||
      f.fileName.toLowerCase() === 'terraform.tfvars'
  );

  const VARS_PLACEHOLDER = `# MigrateOps: this stack uses literal values in main.tf (no var.* references yet).
# Add variable "name" { type = string } blocks when you introduce var.* in resources.
`;

  const TFVARS_PLACEHOLDER = `# MigrateOps: optional environment values for variables declared in variables.tf.
# Example: my_variable = "value"
`;

  if (variablesTfFile && isEmptyOrWhitespace(variablesTfFile.content)) {
    await storage.updateFile(variablesTfFile.id, VARS_PLACEHOLDER);
    console.log(`   ✅ Filled empty variables.tf with placeholder`);
  }

  if (tfvarsFile && isEmptyOrWhitespace(tfvarsFile.content)) {
    await storage.updateFile(tfvarsFile.id, TFVARS_PLACEHOLDER);
    console.log(`   ✅ Filled empty ${tfvarsFile.fileName} with placeholder`);
  }
}

export async function ensureVariablesTfFromMainTf(
  sessionId: string,
  userDescription: string = MIGRATEOPS_DESCRIPTION
): Promise<void> {
  console.log(`\n🔍 Post-processing: Checking for missing variable declarations (session ${sessionId})...`);
  const allFilesAfterSave = await storage.getFilesBySession(sessionId);
  const mainTfFile = allFilesAfterSave.find((f) => f.fileName.toLowerCase() === 'main.tf');
  const variablesTfFile = allFilesAfterSave.find((f) => f.fileName.toLowerCase() === 'variables.tf');
  const tfvarsFile = allFilesAfterSave.find(
    (f) =>
      f.fileName.toLowerCase() === 'dev.terraform.tfvars' || f.fileName.toLowerCase() === 'terraform.tfvars'
  );

  if (!mainTfFile) {
    return;
  }

  const varPattern = /var\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const referencedVars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = varPattern.exec(mainTfFile.content)) !== null) {
    referencedVars.add(match[1]);
  }

  console.log(
    `   Found ${referencedVars.size} variable reference(s) in main.tf: ${Array.from(referencedVars).join(', ')}`
  );

  if (referencedVars.size > 0) {
    const declaredVars = new Set<string>();
    if (variablesTfFile) {
      const varDeclPattern = /variable\s+"([^"]+)"/g;
      let declMatch: RegExpExecArray | null;
      while ((declMatch = varDeclPattern.exec(variablesTfFile.content)) !== null) {
        declaredVars.add(declMatch[1]);
      }
    }

    const missingVars = Array.from(referencedVars).filter((v) => !declaredVars.has(v));

    if (missingVars.length === 0) {
      console.log(`   ✅ All variables are declared in variables.tf`);
    } else {
      console.log(`   ⚠️  Missing ${missingVars.length} variable declaration(s): ${missingVars.join(', ')}`);
      console.log(`   🔧 Creating/updating variables.tf with missing declarations...`);

      const varDeclarations = await openaiService.generateVariableDeclarations(missingVars, mainTfFile.content);

      if (variablesTfFile) {
        const updatedContent = variablesTfFile.content.trim() + '\n\n' + varDeclarations;
        await storage.updateFile(variablesTfFile.id, updatedContent);
        console.log(`   ✅ Updated variables.tf with ${missingVars.length} new declaration(s)`);
      } else {
        await storage.createFile({
          sessionId,
          fileName: 'variables.tf',
          content: varDeclarations,
        });
        console.log(`   ✅ Created variables.tf with ${missingVars.length} declaration(s)`);
      }

      const tfvarsFileName = tfvarsFile?.fileName || 'dev.terraform.tfvars';
      const tfvarsValues = await openaiService.generateTfvarsValues(
        missingVars,
        mainTfFile.content,
        userDescription
      );

      if (tfvarsFile) {
        const existingKeys = new Set<string>();
        tfvarsFile.content.split('\n').forEach((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const keyMatch = trimmed.match(/^([^=]+?)\s*=/);
            if (keyMatch) {
              existingKeys.add(keyMatch[1].trim());
            }
          }
        });

        const newTfvarsLines = tfvarsValues.split('\n').filter((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const keyMatch = trimmed.match(/^([^=]+?)\s*=/);
            if (keyMatch && !existingKeys.has(keyMatch[1].trim())) {
              return true;
            }
          }
          return false;
        });

        if (newTfvarsLines.length > 0) {
          const updatedTfvars = tfvarsFile.content.trim() + '\n\n' + newTfvarsLines.join('\n');
          await storage.updateFile(tfvarsFile.id, updatedTfvars);
          console.log(`   ✅ Updated ${tfvarsFileName} with ${newTfvarsLines.length} new value(s)`);
        }
      } else {
        await storage.createFile({
          sessionId,
          fileName: tfvarsFileName,
          content: tfvarsValues,
        });
        console.log(`   ✅ Created ${tfvarsFileName} with ${missingVars.length} value(s)`);
      }
    }
  } else {
    console.log(`   No var.* references in main.tf — literal-based variables.tf / tfvars may still be generated`);
  }

  const refreshed = await storage.getFilesBySession(sessionId);
  const mainRefreshed = refreshed.find((f) => f.fileName.toLowerCase() === 'main.tf');
  const variablesRefreshed = refreshed.find((f) => f.fileName.toLowerCase() === 'variables.tf');
  const tfvarsRefreshed = refreshed.find(
    (f) =>
      f.fileName.toLowerCase() === 'dev.terraform.tfvars' || f.fileName.toLowerCase() === 'terraform.tfvars'
  );

  if (
    mainRefreshed &&
    referencedVars.size === 0 &&
    (isStubOrEmptyVariablesTf(variablesRefreshed?.content) || isStubOrEmptyTfvars(tfvarsRefreshed?.content))
  ) {
    await syncMigrateOpsVariablesFromMainLiterals(sessionId, mainRefreshed.content);
  }

  await fillEmptyTerraformAuxiliaryFiles(sessionId);
}
