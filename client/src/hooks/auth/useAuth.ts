import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { signup, login, logout, getCurrentUser, type SignupRequest, type LoginRequest } from '@/lib/api/auth';

const AUTH_QUERY_KEY = ['auth', 'currentUser'];

/**
 * Hook for authentication operations
 */
export function useAuth() {
  const queryClient = useQueryClient();

  // Get current user query
  const currentUserQuery = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: getCurrentUser,
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Signup mutation
  const signupMutation = useMutation({
    mutationFn: (data: SignupRequest) => signup(data),
    onSuccess: (data) => {
      // Store token
      localStorage.setItem('token', data.token);
      // Invalidate and refetch current user
      queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });

  // Login mutation
  const loginMutation = useMutation({
    mutationFn: (data: LoginRequest) => login(data),
    onSuccess: (data, variables) => {
      // Store token based on rememberMe
      if (variables.rememberMe) {
        localStorage.setItem('token', data.token);
      } else {
        sessionStorage.setItem('token', data.token);
      }
      // Invalidate and refetch current user
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

