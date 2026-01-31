import { CheckIcon } from "@radix-ui/react-icons";
import { cn } from "@/lib/utils";

interface Step {
  number: number;
  title: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
}

export default function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <nav className="flex items-center justify-center gap-2 mb-8" aria-label="Progress steps">
      {steps.map((step, index) => (
        <div key={step.number} className="flex items-center">
          <div className="flex flex-col items-center gap-2">
            <div
              className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-200 ease-in-out",
                currentStep > step.number
                  ? "bg-gradient-primary text-primary-foreground shadow-primary scale-100"
                  : currentStep === step.number
                  ? "bg-gradient-primary text-primary-foreground shadow-primary-lg scale-105 ring-2 ring-primary/50"
                  : "bg-muted text-muted-foreground scale-100"
              )}
              data-testid={`step-${step.number}`}
              role="progressbar"
              aria-label={`Step ${step.number}: ${step.title}`}
              aria-current={currentStep === step.number ? "step" : undefined}
              aria-completed={currentStep > step.number ? "true" : "false"}
            >
              {currentStep > step.number ? (
                <CheckIcon className="w-5 h-5" />
              ) : (
                step.number
              )}
            </div>
            <span className={cn(
              "text-xs font-medium hidden sm:block",
              currentStep === step.number ? "text-foreground" : "text-muted-foreground"
            )}>
              {step.title}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div
              className={cn(
                "w-12 h-0.5 mx-2 transition-all duration-300 ease-in-out",
                currentStep > step.number 
                  ? "bg-gradient-to-r from-primary to-primary/80" 
                  : "bg-muted"
              )}
            />
          )}
        </div>
      ))}
    </nav>
  );
}
