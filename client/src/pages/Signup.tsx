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
        className="relative z-10 w-full max-w-xl px-4 py-12"
        initial="hidden"
        animate="visible"
        variants={containerVariants}
      >
        <GlassCard>
          <motion.div className="text-center mb-8" variants={itemVariants}>
            <motion.div 
              className="text-5xl mb-2 inline-block"
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            >
              🚀
            </motion.div>
            <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
              AI-Driven Devops
            </h1>
            <p className="text-white/70">Create Your Account</p>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <motion.div variants={itemVariants}>
              <InputField
                label="Username"
                type="text"
                value={formData.username}
                onChange={(value) => handleChange('username', value)}
                error={errors.username}
                placeholder="Choose a username"
                icon="👤"
                required
                autoComplete="username"
              />
            </motion.div>

            <motion.div variants={itemVariants}>
              <InputField
                label="Email"
                type="email"
                value={formData.email}
                onChange={(value) => handleChange('email', value)}
                error={errors.email}
                placeholder="you@example.com"
                icon="📧"
                required
                autoComplete="email"
              />
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
              />
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
                loading={signupMutation.isPending}
                disabled={signupMutation.isPending}
              >
                Sign Up
              </SubmitButton>
            </motion.div>
          </form>

          <motion.div className="mt-8 text-center" variants={itemVariants}>
            <p className="text-white/60 text-sm">
              Already have an account?{' '}
              <a
                href="/login"
                onClick={(e) => {
                  e.preventDefault();
                  setLocation('/login');
                }}
                className="text-cyan-400 hover:text-cyan-300 font-medium underline-offset-4 hover:underline transition-all"
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

