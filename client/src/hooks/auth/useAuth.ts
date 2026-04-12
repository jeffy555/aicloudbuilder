import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  signup,
  login,
  logout,
  getCurrentUser,
  persistAuthToken,
  type SignupRequest,
  type LoginRequest,
} from '@/lib/api/auth';

const AUTH_QUERY_KEY = ['auth', 'currentUser'];

/**
 * Hook for authentication operations
 */
export function useAuth() {
  const queryClient = useQueryClient();

  // Get current user query
  // JWT is valid for 7 days — no need to re-validate frequently.
  // Short staleTime caused the app to redirect to /login after idle periods
  // when the server had restarted (MemStorage lost users) or on transient errors.
  const currentUserQuery = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: getCurrentUser,
    retry: 1,
    retryDelay: 2000,
    staleTime: 60 * 60 * 1000, // 1 hour — matches reasonable session duration
    gcTime: 2 * 60 * 60 * 1000, // 2 hours — keep cached auth data longer
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Signup mutation
  const signupMutation = useMutation({
    mutationFn: (data: SignupRequest) => signup(data),
    onSuccess: (data) => {
      persistAuthToken(data.token, true);
      queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });

  // Login mutation
  const loginMutation = useMutation({
    mutationFn: (data: LoginRequest) => login(data),
    onSuccess: (data, variables) => {
      persistAuthToken(data.token, Boolean(variables.rememberMe));
      queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });

  // Logout mutation
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      // Clear tokens
      localStorage.removeItem('token');
      sessionStorage.removeItem('token');
      // Clear user query
      queryClient.setQueryData(AUTH_QUERY_KEY, null);
      queryClient.removeQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });

  return {
    // Current user
    user: currentUserQuery.data?.user,
    isLoading: currentUserQuery.isLoading,
    isAuthenticated: !!currentUserQuery.data?.user,
    
    // Signup
    signup: signupMutation.mutate,
    signupAsync: signupMutation.mutateAsync,
    isSigningUp: signupMutation.isPending,
    signupError: signupMutation.error,
    
    // Login
    login: loginMutation.mutate,
    loginAsync: loginMutation.mutateAsync,
    isLoggingIn: loginMutation.isPending,
    loginError: loginMutation.error,
    
    // Logout
    logout: logoutMutation.mutate,
    logoutAsync: logoutMutation.mutateAsync,
    isLoggingOut: logoutMutation.isPending,
    
    // Refetch user
    refetchUser: currentUserQuery.refetch,
  };
}

