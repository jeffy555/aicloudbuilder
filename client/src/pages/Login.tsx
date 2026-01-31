import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import VideoBackground from '@/components/auth/VideoBackground';
import GlassCard from '@/components/ui/GlassCard';
import InputField from '@/components/auth/InputField';
import PasswordField from '@/components/auth/PasswordField';
import SubmitButton from '@/components/auth/SubmitButton';
import { useFormValidation, type LoginFormData } from '@/hooks/auth/useFormValidation';
import { login } from '@/lib/api/auth';

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { validateLoginForm } = useFormValidation();
  
  const [formData, setFormData] = useState<LoginFormData>({
    usernameOrEmail: '',
    password: '',
    rememberMe: false,
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('registered') === 'true') {
      toast({
        title: "Account created!",
        description: "Please log in with your new credentials.",
        variant: "default",
      });
      window.history.replaceState({}, '', '/login');
    }
  }, []);

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: (data) => {
      if (formData.rememberMe) {
        localStorage.setItem('token', data.token);
      } else {
        sessionStorage.setItem('token', data.token);
      }
      
      toast({
        title: "Welcome back!",
        description: `Logged in as ${data.user.username}`,
        variant: "default",
      });
      
      setLocation('/');
    },
    onError: (error: Error) => {
      toast({
        title: "Login failed",
        description: error.message || "Invalid credentials",
        variant: "destructive",
      });
      setErrors({ submit: error.message || 'Invalid credentials. Please try again.' });
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validationErrors = validateLoginForm(formData);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    loginMutation.mutate({
      usernameOrEmail: formData.usernameOrEmail,
      password: formData.password,
      rememberMe: formData.rememberMe,
    });
  };

  const handleChange = (field: keyof LoginFormData, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field as string]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field as string];
        return newErrors;
      });
    }
  };

  const containerVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: { duration: 0.6, staggerChildren: 0.1 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, x: -10 },
    visible: { opacity: 1, x: 0 }
  };

  return (
    <div className="min-h-screen flex items-center justify-end relative overflow-hidden px-4 md:px-12">
      <VideoBackground clarityMode="high" fallbackGradient={false} />
      
      <motion.div 
        className="relative z-10 w-full max-w-lg px-4 py-12"
        initial="hidden"
        animate="visible"
        variants={containerVariants}
      >
        <GlassCard>
          <motion.div className="text-center mb-8" variants={itemVariants}>
            <motion.div 
              className="text-5xl mb-2 inline-block"
              animate={{ rotate: [0, 5, -5, 0] }}
              transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
            >
              🚀
            </motion.div>
            <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
              AI-Driven Devops
            </h1>
            <p className="text-white/70">Welcome Back</p>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <motion.div variants={itemVariants}>
              <InputField
                label="Username or Email"
                type="text"
                value={formData.usernameOrEmail}
                onChange={(value) => handleChange('usernameOrEmail', value)}
                error={errors.usernameOrEmail}
                placeholder="Enter your credentials"
                icon="👤"
                required
                autoComplete="username"
              />
            </motion.div>

            <motion.div variants={itemVariants}>
              <PasswordField
                label="Password"
                value={formData.password}
                onChange={(value) => handleChange('password', value)}
                error={errors.password}
                placeholder="Enter your password"
                required
                autoComplete="current-password"
              />
            </motion.div>

            <motion.div className="flex items-center justify-between" variants={itemVariants}>
              <label className="flex items-center space-x-2 cursor-pointer group">
                <div className="relative flex items-center">
                  <input
                    type="checkbox"
                    checked={formData.rememberMe}
                    onChange={(e) => handleChange('rememberMe', e.target.checked)}
                    className="w-4 h-4 rounded border-white/30 bg-white/5 text-cyan-400 focus:ring-cyan-400 focus:ring-offset-0 focus:ring-2 transition-all cursor-pointer"
                  />
                </div>
                <span className="text-white/60 text-sm group-hover:text-white/80 transition-colors">Remember me</span>
              </label>
              
              <a
                href="/forgot-password"
                onClick={(e) => {
                  e.preventDefault();
                  toast({
                    title: "Coming soon",
                    description: "Password reset functionality is being implemented.",
                  });
                }}
                className="text-cyan-400 hover:text-cyan-300 text-sm font-medium underline-offset-4 hover:underline transition-all"
              >
                Forgot password?
              </a>
            </motion.div>

            {errors.submit && (
              <motion.div 
                className="text-red-400 text-sm text-center bg-red-400/10 py-2 rounded-md border border-red-400/20" 
                role="alert"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                {errors.submit}
              </motion.div>
            )}

            <motion.div variants={itemVariants} className="pt-2">
              <SubmitButton
                type="submit"
                loading={loginMutation.isPending}
                disabled={loginMutation.isPending}
              >
                Login
              </SubmitButton>
            </motion.div>
          </form>

          <motion.div className="mt-8 text-center" variants={itemVariants}>
            <p className="text-white/60 text-sm">
              Don't have an account?{' '}
              <a
                href="/signup"
                onClick={(e) => {
                  e.preventDefault();
                  setLocation('/signup');
                }}
                className="text-cyan-400 hover:text-cyan-300 font-medium underline-offset-4 hover:underline transition-all"
              >
                Sign Up
              </a>
            </p>
          </motion.div>
        </GlassCard>
      </motion.div>
    </div>
  );
}

