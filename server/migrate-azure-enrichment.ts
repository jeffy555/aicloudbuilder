/**
 * Derives explicit Terraform-oriented hints from live Azure ARM `properties` so the model
 * maps real configuration instead of guessing. Does not replace full `properties` (still sent).
 *
 * Also attaches:
 * - `migrateopsSchemaGuidance` — ARM → azurerm 4.x attribute mapping (types, renames).
 * - `migrateopsResolvedTerraform` — **authoritative** pre-computed values from ARM (see migrate-resolve.ts)
 *   so the model copies real numbers (e.g. ingress target_port) instead of guessing.
 */

import { getSchemaGuidanceForType } from './migrate-schema-guidance.js';
import {
  buildMigrateOpsResolvedTerraform,
  resolveContainerAppRegistriesForTerraform,
  normalizeIngressTransportFromArm,
} from './migrate-resolve.js';

export function enrichAzureResourcesForMigrateOps<T extends Record<string, unknown>>(resources: T[]): T[] {
  return resources.map((r) => {
    const type = String((r as any).type || '').toLowerCase();
    const props = (r as any).properties as Record<string, unknown> | undefined;

    let out: T = r;

    const guidance = getSchemaGuidanceForType(type);
    const resolvedTf = buildMigrateOpsResolvedTerraform(r as any);
    if (resolvedTf) {
      out = { ...out, migrateopsResolvedTerraform: resolvedTf } as T;
    }

    if (guidance) {
      const compact: Record<string, unknown> = {
        terraformType: guidance.terraformType,
      };
      if (guidance.requiredArguments?.length) {
        compact.requiredArguments = guidance.requiredArguments;
      }
      if (guidance.propertyMap) compact.armToTerraformMap = guidance.propertyMap;
      if (guidance.renamedAttributes && Object.keys(guidance.renamedAttributes).length > 0) {
        compact.renamedIn4x = guidance.renamedAttributes;
      }
      if (guidance.removedAttributes?.length) compact.removedIn4x = guidance.removedAttributes;
      if (guidance.notes) compact.migrationNote = guidance.notes;
      out = { ...out, migrateopsSchemaGuidance: compact };
    }

    if (!props || typeof props !== 'object') return out;

    const hints: Record<string, unknown> = {};

    if (type.includes('microsoft.app/containerapps')) {
      const template = props.template as Record<string, unknown> | undefined;
      const containers = (template?.containers as unknown[]) || [];
      const registriesArm = (props.configuration as any)?.registries;
      const registriesResolved = resolveContainerAppRegistriesForTerraform(r as any);
      hints.containerApp = {
        revisionMode: props.revisionMode,
        workloadProfileName: props.workloadProfileName,
        containers: containers.map((c: any) => ({
          name: c?.name,
          image: c?.image,
          cpu: c?.resources?.cpu ?? c?.cpu,
          memory: c?.resources?.memory ?? c?.memory,
          command: c?.command,
          args: c?.args,
          env: c?.env,
          probes: c?.probes ? '[see properties]' : undefined,
        })),
        scale: template?.scale,
        dapr: template?.dapr,
        volumes: template?.volumes,
        ingress: (props.configuration as any)?.ingress,
        /** Terraform requires lowercase; ARM often sends Auto/Http — same as migrateopsResolvedTerraform */
        ingressTransportForTerraform: normalizeIngressTransportFromArm(
          (props.configuration as any)?.ingress?.transport
        ),
        /** ARM field names — Terraform mapping is NOT 1:1 snake_case */
        registriesArmSummary: Array.isArray(registriesArm)
          ? registriesArm.map((x: any) => ({
              server: x?.server,
              username: x?.username,
              passwordSecretRef: x?.passwordSecretRef,
            }))
          : undefined,
        /** Pre-mapped for HCL — copy into registry {} blocks verbatim */
        registriesForTerraform: registriesResolved,
      };
    }

    if (type.includes('microsoft.app/managedenvironments')) {
      hints.managedEnvironment = {
        zoneRedundant: props.zoneRedundant,
        workloadProfiles: props.workloadProfiles,
        customDomainConfiguration: props.customDomainConfiguration,
        infrastructureResourceGroup: props.infrastructureResourceGroup,
      };
    }

    if (type.includes('microsoft.containerregistry')) {
      hints.containerRegistry = {
        adminUserEnabled: props.adminUserEnabled,
        publicNetworkAccess: props.publicNetworkAccess,
        sku: (props as any).sku,
        policies: props.policies,
      };
    }

    if (type.includes('microsoft.operationalinsights')) {
      hints.logAnalytics = {
        sku: (props as any).sku,
        retentionInDays: props.retentionInDays,
      };
    }

    if (type.includes('microsoft.network/dnszones')) {
      hints.dnsZone = {
        zoneType: props.zoneType,
        resolutionVirtualNetworks: props.resolutionVirtualNetworks,
      };
    }

    if (Object.keys(hints).length === 0) return out;

    return { ...out, migrateopsTerraformHints: hints } as T;
  });
}
