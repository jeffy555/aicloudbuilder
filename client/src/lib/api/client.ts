/**
 * Type-safe API Client (SDD Phase 3)
 *
 * Uses openapi-fetch to provide fully-typed API calls derived from the OpenAPI spec.
 * All request params, bodies, and responses are type-checked at compile time.
 *
 * Usage:
 *   import { api } from "@/lib/api/client";
 *   const { data, error } = await api.GET("/api/sessions/{id}", { params: { path: { id } } });
 *   // data is fully typed as the session response
 */
import createClient from "openapi-fetch";
import type { paths } from "./types";

function getToken(): string | null {
  return localStorage.getItem("token") || sessionStorage.getItem("token");
}

export const api = createClient<paths>({
  baseUrl: "",
  headers: {
    "Content-Type": "application/json",
  },
});

// Add auth header via middleware
api.use({
  async onRequest({ request }) {
    const token = getToken();
    if (token) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return request;
  },
  async onResponse({ response }) {
    // Handle 401 — clear stale token and redirect to login
    if (response.status === 401) {
      const token = getToken();
      if (token) {
        try {
          const body = await response.clone().json().catch(() => ({}));
          if (body?.code !== "INVALID_PROVIDER_CREDENTIALS") {
            localStorage.removeItem("token");
            sessionStorage.removeItem("token");
            window.location.href = "/login";
          }
        } catch {
          localStorage.removeItem("token");
          sessionStorage.removeItem("token");
          window.location.href = "/login";
        }
      }
    }
    return response;
  },
});
