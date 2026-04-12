/**
 * GitHub Actions CI for Terraform module workflow (standalone-root & aggregated-root only).
 * Child-module approach does not provision these workflows.
 */

export const TERRAFORM_MODULE_VALIDATE_WORKFLOW = 'terraform-module-validate.yml';
export const TERRAFORM_MODULE_APPLY_WORKFLOW = 'terraform-module-apply.yml';

export function isTerraformRootModuleCicdSession(session: {
  activeModule?: string | null;
  moduleApproach?: string | null;
}): boolean {
  const rootApproach =
    session.moduleApproach === 'standalone-root' || session.moduleApproach === 'aggregated-root';
  if (!rootApproach) return false;
  // Terraform workflow should set activeModule; allow null/other only when approach clearly identifies this flow
  if (session.activeModule && session.activeModule !== 'terraform') return false;
  return true;
}

export function preserveSessionFilesAfterTerraformRootCommit(session: {
  activeModule?: string | null;
  moduleApproach?: string | null;
}): boolean {
  return isTerraformRootModuleCicdSession(session);
}
