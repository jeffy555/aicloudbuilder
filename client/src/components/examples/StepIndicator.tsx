import StepIndicator from '../StepIndicator';

export default function StepIndicatorExample() {
  const steps = [
    { number: 1, title: 'Provider' },
    { number: 2, title: 'Repository' },
    { number: 3, title: 'Generate' },
    { number: 4, title: 'Review' },
  ];

  return (
    <div className="p-6">
      <StepIndicator steps={steps} currentStep={2} />
    </div>
  );
}
