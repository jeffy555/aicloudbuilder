import { Button } from "@/components/ui/button";
import { CheckCircledIcon, ReloadIcon } from "@radix-ui/react-icons";

interface ActionButtonsProps {
  onApprove: () => void;
  onCancel: () => void;
  approveText?: string;
  cancelText?: string;
  loading?: boolean;
}

export default function ActionButtons({
  onApprove,
  onCancel,
  approveText = "Approve & Commit",
  cancelText = "Cancel",
  loading = false
}: ActionButtonsProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-3 justify-end">
      <Button
        variant="outline"
        onClick={onCancel}
        disabled={loading}
        className="w-full sm:w-auto"
        data-testid="button-cancel"
      >
        {cancelText}
      </Button>
      <Button
        onClick={onApprove}
        disabled={loading}
        className="w-full sm:w-auto gap-2"
        data-testid="button-approve"
      >
        {loading ? (
          <>
            <ReloadIcon className="w-5 h-5 animate-spin" />
            Processing...
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
