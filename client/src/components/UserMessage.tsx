interface UserMessageProps {
  message: string;
}

export default function UserMessage({ message }: UserMessageProps) {
  return (
    <div className="flex justify-end mb-4">
      <div className="bg-primary text-primary-foreground rounded-2xl p-4 max-w-lg">
        <p className="text-base">{message}</p>
      </div>
    </div>
  );
}
