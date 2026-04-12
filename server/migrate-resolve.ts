/**
 * Single source of truth: derive Terraform-ready values from live Azure ARM JSON.
 * Used by enrichment (for the AI) and by deterministic HCL fixes — same logic, no drift.
 *
 * Goal: minimize blind fallbacks; every number should trace to an ARM field when possible.
 */

export type ResolvedIngressPort = {
  target_port: number;
  /** Human-readable provenance for logs / UI */
  source: string;
};

const COMMON_PORT_ENV_NAMES = new Set(['PORT', 'WEBSITES_PORT', 'ASPNETCORE_URLS']);

/** Terraform ingress.transport — lowercase only. ARM often returns "Auto", "Http", "Tcp". */
export const INGRESS_TRANSPORT_ALLOWED = ['auto', 'http', 'http2', 'tcp'] as const;
export type IngressTransportValue = (typeof INGRESS_TRANSPORT_ALLOWED)[number];

/**
 * Normalize ARM / API ingress transport strings to what hashicorp/azurerm expects.
 * This is enum coercion from Azure’s display casing — not an arbitrary fallback.
 */
export function normalizeIngressTransportFromArm(raw: unknown): IngressTransportValue {
  const s = String(raw ?? 'auto').trim().toLowerCase();
  if ((INGRESS_TRANSPORT_ALLOWED as readonly string[]).includes(s)) {
    return s as IngressTransportValue;
  }
  return 'auto';
}

/**
 * Infer Container App ingress target port from ARM `properties`.
 * Order: ingress.targetPort → probe ports → container ports → PORT-like env vars → additionalPortMappings.
 */
export function resolveContainerAppIngressTargetPort(r: any): ResolvedIngressPort {
  const props = r?.properties;
  const ingress = props?.configuration?.ingress;

  const direct = ingress?.targetPort;
  if (typeof direct === 'number' && direct >= 1 && direct <= 65535) {
    return { target_port: direct, source: 'configuration.ingress.targetPort' };
  }

  const containers = props?.template?.containers || [];
  for (const c of containers) {
    const cname = c?.name ? String(c.name) : 'container';

    for (const probe of c?.probes || []) {
      const p =
        probe?.httpGet?.port ??
        probe?.tcpSocket?.port ??
        probe?.port ??
        probe?.HttpGet?.port;
      if (typeof p === 'number' && p >= 1 && p <= 65535) {
        return { target_port: p, source: `template.containers.${cname}.probe.port` };
      }
    }

    for (const port of c?.ports || []) {
      const p = port?.containerPort ?? port?.port;
      if (typeof p === 'number' && p >= 1 && p <= 65535) {
        return { target_port: p, source: `template.containers.${cname}.ports[].containerPort` };
      }
    }

    for (const e of c?.env || []) {
      const en = String(e?.name || '');
      if (COMMON_PORT_ENV_NAMES.has(en.toUpperCase()) && e?.value != null) {
        const raw = String(e.value).trim();
        const parsed = parseInt(
          raw.replace(/^.*:(\d+).*$/, '$1') || raw,
          10
        );
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          return {
            target_port: parsed,
            source: `template.containers.${cname}.env.${en}`,
          };
        }
      }
    }
  }

  const apm = ingress?.additionalPortMappings;
  if (Array.isArray(apm)) {
    for (let i = 0; i < apm.length; i++) {
      const m = apm[i];
      const p = m?.targetPort ?? m?.target_port;
      if (typeof p === 'number' && p >= 1 && p <= 65535) {
        return { target_port: p, source: `configuration.ingress.additionalPortMappings[${i}].targetPort` };
      }
    }
  }

  // Last resort — explicit in logs; user should verify in Portal
  return {
    target_port: 8080,
    source:
      'migrateops_fallback: no listen port found in ARM (ingress 0, no probe/container/env PORT) — verify in Azure Portal → Container App → Ingress',
  };
}

/**
 * ARM `configuration.registries[]` uses `passwordSecretRef` (secret name string).
 * Terraform `registry {}` requires `password_secret_name` — NOT `password_secret_ref`.
 * This pre-builds the exact blocks the model should emit.
 */
export function resolveContainerAppRegistriesForTerraform(r: any): Array<{
  server: string;
  username?: string;
  password_secret_name: string;
  identity?: string;
  _armFieldPasswordWas: 'passwordSecretRef';
}> {
  const props = r?.properties;
  const list = props?.configuration?.registries ?? props?.configuration?.Registries;
  if (!Array.isArray(list) || list.length === 0) return [];

  const out: Array<{
    server: string;
    username?: string;
    password_secret_name: string;
    identity?: string;
    _armFieldPasswordWas: 'passwordSecretRef';
  }> = [];

  for (const reg of list) {
    const server = reg?.server ?? reg?.Server;
    const username = reg?.username ?? reg?.Username;
    const secretName =
      reg?.passwordSecretRef ??
      reg?.password_secret_ref ??
      reg?.passwordSecretName ??
      reg?.password_secret_name;
    if (typeof server !== 'string' || !server.trim()) continue;
    if (typeof secretName === 'string' && secretName.trim()) {
      out.push({
        server: server.trim(),
        username: typeof username === 'string' ? username : undefined,
        password_secret_name: secretName.trim(),
        identity: typeof reg?.identity === 'string' ? reg.identity : undefined,
        _armFieldPasswordWas: 'passwordSecretRef',
      });
    }
  }

  return out;
}

/**
 * Build a compact object the AI must treat as authoritative for HCL generation.
 */
export function buildMigrateOpsResolvedTerraform(r: any): Record<string, unknown> | undefined {
  const type = String(r?.type || '').toLowerCase();
  const out: Record<string, unknown> = {};

  if (type.includes('microsoft.app/containerapps')) {
    const ingress = resolveContainerAppIngressTargetPort(r);
    const props = r?.properties;
    const ing = props?.configuration?.ingress;
    const registries = resolveContainerAppRegistriesForTerraform(r);

    const app: Record<string, unknown> = {
      ingress: {
        target_port: ingress.target_port,
        _resolvedFrom: ingress.source,
        external_enabled: ing?.external === true,
        /** Always lowercase — Terraform rejects "Auto", "HTTP", etc. */
        transport: normalizeIngressTransportFromArm(ing?.transport),
        _transportSourceNote:
          'ARM configuration.ingress.transport may be PascalCase (e.g. Auto); Terraform requires auto|http|http2|tcp',
        allow_insecure_connections: ing?.allowInsecure === true,
      },
      revision_mode: String(props?.revisionMode || '').toLowerCase() === 'multiple' ? 'Multiple' : 'Single',
      container_app_environment_id: props?.managedEnvironmentId,
      /** Emit these exact registry {} blocks — Terraform arg is password_secret_name (ARM: passwordSecretRef) */
      registry_blocks: registries,
      _terraformRegistryRule:
        'For each item in registry_blocks use: registry { server = "..." username = "..." password_secret_name = "..." } — NEVER password_secret_ref',
    };

    out.azurerm_container_app = app;
  }

  return Object.keys(out).length ? out : undefined;
}
