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
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((step, index) => (
        <div key={step.number} className="flex items-center">
          <div className="flex flex-col items-center gap-2">
            <div
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors",
                currentStep > step.number
                  ? "bg-primary text-primary-foreground"
                  : currentStep === step.number
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}
              data-testid={`step-${step.number}`}
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
                "w-12 h-0.5 mx-2 transition-colors",
                currentStep > step.number ? "bg-primary" : "bg-muted"
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}
