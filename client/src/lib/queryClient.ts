import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    // Clone the response so we can read it without consuming the original
    const clonedRes = res.clone();
    let errorMessage = res.statusText;
    
    try {
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        // Try to parse as JSON
        const json = await clonedRes.json();
        errorMessage = json.error || json.message || json.details || JSON.stringify(json);
      } else {
        // Try to read as text
        const text = await clonedRes.text();
        // If it's HTML, provide a more user-friendly message
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          errorMessage = `Server error (${res.status}): ${res.statusText}. Please check the server logs.`;
        } else {
          // Try to extract JSON from text (in case it's wrapped)
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const json = JSON.parse(jsonMatch[0]);
              errorMessage = json.error || json.message || json.details || errorMessage;
            } catch {
              errorMessage = text.substring(0, 200); // Limit error message length
            }
          } else {
            errorMessage = text.substring(0, 200); // Limit error message length
          }
        }
      }
    } catch (parseError) {
      // If parsing fails, use status text
      errorMessage = res.statusText;
    }
    
    const error = new Error(`${res.status}: ${errorMessage}`);
    (error as any).status = res.status;
    throw error;
  }
}

function clearStaleToken() {
  localStorage.removeItem('token');
  sessionStorage.removeItem('token');
}

// Track whether a 401 redirect is already in progress to prevent multiple redirects
let isRedirecting = false;

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token');
  const headers: Record<string, string> = {};

  if (data) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  // Only redirect to login when the server explicitly rejects the JWT (expired/invalid).
  // Don't redirect on transient 401s (e.g. server restart with MemStorage losing user records).
  if (res.status === 401 && token) {
    try {
      const cloned = res.clone();
      const body = await cloned.json().catch(() => ({}));
      if (body?.code === 'INVALID_PROVIDER_CREDENTIALS') {
        // External provider credential error — don't touch our JWT
      } else if (body?.error === 'Invalid or expired token' || body?.error === 'Token verification failed') {
        // Server explicitly says JWT is bad — clear and redirect
        if (!isRedirecting) {
          isRedirecting = true;
          clearStaleToken();
          window.location.href = '/login';
        }
        return res;
      }
      // Other 401s: don't clear token, let the error propagate normally
    } catch {
      // Parse failure — don't assume JWT is bad
    }
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    const headers: Record<string, string> = {};

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(queryKey.join("/") as string, {
      headers,
      credentials: "include",
    });

    if (res.status === 401) {
      if (token) {
        const body = await res.clone().json().catch(() => ({}));
        if (body?.code === 'INVALID_PROVIDER_CREDENTIALS') {
          // External provider credential error — don't clear our JWT
        } else if (body?.error === 'Invalid or expired token' || body?.error === 'Token verification failed') {
          // Server explicitly rejected the JWT — clear token and redirect once
          if (!isRedirecting) {
            isRedirecting = true;
            clearStaleToken();
            window.location.href = '/login';
          }
          return null;
        }
        // For other 401s (e.g. server restart lost MemStorage users, transient errors),
        // don't clear the token — the JWT may still be valid. Just return null or throw
        // so the query retries on next interval without nuking the session.
      }
      if (unauthorizedBehavior === "returnNull") {
        return null;
      }
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
