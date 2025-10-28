import { Button } from "@/components/ui/button";
import { CheckCircledIcon, ReloadIcon } from "@radix-ui/react-icons";

interface ActionButtonsProps {
  onApprove: () => void;
  onCancel: () => void;
  approveText?: string;
  cancelText?: string;
  loading?: boolean;
  disabled?: boolean;
}

export default function ActionButtons({
  onApprove,
  onCancel,
  approveText = "Approve & Commit",
  cancelText = "Cancel",
  loading = false,
  disabled = false
}: ActionButtonsProps) {
  const isDisabled = loading || disabled;
  
  return (
    <div className="flex flex-col sm:flex-row gap-3 justify-end">
      <Button
        variant="outline"
        onClick={onCancel}
        disabled={isDisabled}
        className="w-full sm:w-auto"
        data-testid="button-cancel"
      >
        {cancelText}
      </Button>
      <Button
        onClick={onApprove}
        disabled={isDisabled}
        className="w-full sm:w-auto gap-2"
        data-testid="button-approve"
      >
        {loading ? (
          <>
            <ReloadIcon className="w-5 h-5 animate-spin" />
            Processing...
          </>
        ) : disabled ? (
          <>
            <CheckCircledIcon className="w-5 h-5" />
            Committed
          </>
        ) : (
          <>
            <CheckCircledIcon className="w-5 h-5" />
            {approveText}
          </>
        )}
      </Button>
    </div>
  );
}
