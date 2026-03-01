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

  // If server rejects our token as invalid/expired, clear it so the browser
  // stops sending a stale token on every subsequent request.
  if (res.status === 401 && token) {
    clearStaleToken();
    // Redirect to login so the user can get a fresh token
    window.location.href = '/login';
    return res;
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
        // Stale/invalid token — clear it so we stop sending it
        clearStaleToken();
        window.location.href = '/login';
        return null;
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
