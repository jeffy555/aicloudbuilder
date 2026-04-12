import { useState } from 'react';
import { useLocation } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import VideoBackground from '@/components/auth/VideoBackground';
import GlassCard from '@/components/ui/GlassCard';
import InputField from '@/components/auth/InputField';
import PasswordField from '@/components/auth/PasswordField';
import SubmitButton from '@/components/auth/SubmitButton';
import MicrosoftSignInButton from '@/components/auth/MicrosoftSignInButton';
import { useFormValidation, type SignupFormData } from '@/hooks/auth/useFormValidation';
import { signup } from '@/lib/api/auth';

export default function Signup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { validateSignupForm } = useFormValidation();
  
  const [formData, setFormData] = useState<SignupFormData>({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});

  const signupMutation = useMutation({
    mutationFn: signup,
    onSuccess: () => {
      toast({
        title: "Registration successful!",
        description: "You can now log in with your credentials.",
        variant: "default",
      });
      setLocation('/login?registered=true');
    },
    onError: (error: Error) => {
      toast({
        title: "Signup failed",
        description: error.message || "An unexpected error occurred",
        variant: "destructive",
      });
      
      if (error.message.includes('already exists')) {
        if (error.message.includes('Username')) {
          setErrors({ username: 'Username already exists' });
        } else if (error.message.includes('Email')) {
          setErrors({ email: 'Email already exists' });
        }
      } else {
        setErrors({ submit: error.message || 'Signup failed. Please try again.' });
      }
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validationErrors = validateSignupForm(formData);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    signupMutation.mutate({
      username: formData.username,
      email: formData.email,
      password: formData.password,
    });
  };

  const handleChange = (field: keyof SignupFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
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
      <VideoBackground />

      <motion.div
        className="relative z-10 w-full max-w-sm px-2"
        initial="hidden"
        animate="visible"
        variants={containerVariants}
      >
        <GlassCard className="!p-5">
          {/* Compact header */}
          <motion.div className="flex items-center justify-center gap-2 mb-4" variants={itemVariants}>
            <motion.span
              className="text-2xl"
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            >
              🚀
            </motion.span>
            <div>
              <h1 className="text-lg font-bold text-white leading-tight">AI-Driven DevOps</h1>
              <p className="text-white/50 text-xs">Create your account</p>
            </div>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-2.5" data-testid="signup-form">
            {/* Username + Email side by side */}
            <motion.div className="grid grid-cols-2 gap-2" variants={itemVariants}>
              <div>
                <label className="block text-white/80 text-xs font-medium mb-1">
                  Username <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => handleChange('username', e.target.value)}
                  placeholder="username"
                  autoComplete="username"
                  required
                  data-testid="signup-username-input"
                  className={`w-full px-3 py-2 rounded-lg bg-white/10 border text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent transition-all ${errors.username ? 'border-red-400' : 'border-white/20'}`}
                />
                {errors.username && <p className="mt-0.5 text-xs text-red-400" data-testid="signup-username-error">{errors.username}</p>}
              </div>
              <div>
                <label className="block text-white/80 text-xs font-medium mb-1">
                  Email <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                  data-testid="signup-email-input"
                  className={`w-full px-3 py-2 rounded-lg bg-white/10 border text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent transition-all ${errors.email ? 'border-red-400' : 'border-white/20'}`}
                />
                {errors.email && <p className="mt-0.5 text-xs text-red-400" data-testid="signup-email-error">{errors.email}</p>}
              </div>
            </motion.div>

            <motion.div variants={itemVariants}>
              <PasswordField
                label="Password"
                value={formData.password}
                onChange={(value) => handleChange('password', value)}
                error={errors.password}
                placeholder="Create a strong password"
                showStrengthIndicator
                required
                autoComplete="new-password"
                testId="signup-password-input"
              />
            </motion.div>

            <motion.div variants={itemVariants}>
              <PasswordField
                label="Confirm Password"
                value={formData.confirmPassword}
                onChange={(value) => handleChange('confirmPassword', value)}
                error={errors.confirmPassword}
                placeholder="Repeat your password"
                required
                autoComplete="new-password"
                testId="signup-confirm-password-input"
              />
            </motion.div>

            {errors.submit && (
              <motion.div
                className="text-red-400 text-xs text-center bg-red-400/10 py-1.5 rounded-md border border-red-400/20"
                role="alert"
                data-testid="signup-error-alert"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                {errors.submit}
              </motion.div>
            )}

            <motion.div variants={itemVariants}>
              <SubmitButton
                type="submit"
                loading={signupMutation.isPending}
                disabled={signupMutation.isPending}
                testId="signup-submit"
              >
                Sign Up
              </SubmitButton>
            </motion.div>
          </form>

          {/* SSO */}
          <motion.div variants={itemVariants} className="mt-3">
            <div className="relative flex items-center gap-3">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-white/40 text-xs shrink-0">or sign up with</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>
          </motion.div>

          <motion.div variants={itemVariants} className="mt-2">
            <MicrosoftSignInButton label="Sign up with Microsoft" testId="signup-microsoft-sso" />
          </motion.div>

          <motion.div className="mt-3 text-center" variants={itemVariants}>
            <p className="text-white/50 text-xs">
              Already have an account?{' '}
              <a
                href="/login"
                data-testid="signup-login-link"
                onClick={(e) => { e.preventDefault(); setLocation('/login'); }}
                className="text-cyan-400 hover:text-cyan-300 font-medium transition-all"
              >
                Login
              </a>
            </p>
          </motion.div>
        </GlassCard>
      </motion.div>
    </div>
  );
}

