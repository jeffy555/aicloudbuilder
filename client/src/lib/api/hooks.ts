/**
 * Type-safe React Query Hooks (SDD Phase 3)
 *
 * Factory helpers that wrap the typed API client in useQuery/useMutation.
 * These gradually replace untyped useQuery({ queryKey: [...] }) calls.
 *
 * Usage:
 *   const { data: session } = useSession(id);
 *   const { data: files } = useSessionFiles(id);
 *   const commitMutation = useCommitFiles(id);
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ── Sessions ────────────────────────────────────────────────────────────

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: ["/api/sessions", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await api.GET("/api/sessions/{id}", {
        params: { path: { id } },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    enabled: !!id,
  });
}

export function useSessionMessages(id: string | undefined) {
  return useQuery({
    queryKey: ["/api/sessions", id, "messages"],
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await api.GET("/api/sessions/{id}/messages", {
        params: { path: { id } },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    enabled: !!id,
  });
}

export function useSessionFiles(id: string | undefined) {
  return useQuery({
    queryKey: ["/api/sessions", id, "files"],
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await api.GET("/api/sessions/{id}/files", {
        params: { path: { id } },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    enabled: !!id,
  });
}

// ── Auth ─────────────────────────────────────────────────────────────────

export function useCurrentUser() {
  return useQuery({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/auth/me");
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    retry: false,
  });
}

// ── Repositories ────────────────────────────────────────────────────────

export function useRepositories(provider: "github" | "azure" | undefined) {
  return useQuery({
    queryKey: ["/api/repositories", provider],
    queryFn: async () => {
      if (!provider) return [];
      const { data, error } = await api.GET("/api/repositories/{provider}", {
        params: { path: { provider } },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    enabled: !!provider,
  });
}

export function useSessionBranches(id: string | undefined) {
  return useQuery({
    queryKey: ["/api/sessions", id, "branches"],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await api.GET("/api/sessions/{id}/branches", {
        params: { path: { id } },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    enabled: !!id,
  });
}

// ── Mutations ───────────────────────────────────────────────────────────

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/sessions");
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
  });
}

export function useUpdateSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Record<string, any>) => {
      const { data, error } = await api.PATCH("/api/sessions/{id}", {
        params: { path: { id } },
        body: body as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/sessions", id] });
    },
  });
}

export function useSendChat(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (message: string) => {
      const { data, error } = await api.POST("/api/sessions/{id}/chat", {
        params: { path: { id } },
        body: { message } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/sessions", id, "messages"] });
    },
  });
}

// ── Health ───────────────────────────────────────────────────────────────

export function useHealthCheck() {
  return useQuery({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/health");
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  });
}

// ── User Secrets ────────────────────────────────────────────────────────

export function useUserSecrets() {
  return useQuery({
    queryKey: ["/api/user/secrets"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/user/secrets");
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  });
}

// ── History ─────────────────────────────────────────────────────────────

export function useUserHistory(params?: { module?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ["/api/user/history", params],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/user/history", {
        params: { query: params as any },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  });
}
