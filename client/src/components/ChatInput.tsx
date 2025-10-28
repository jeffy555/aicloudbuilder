import { PaperPlaneIcon } from "@radix-ui/react-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function ChatInput({ onSend, placeholder = "Type your message...", disabled = false }: ChatInputProps) {
  const [message, setMessage] = useState("");

  const handleSend = () => {
    if (message.trim() && !disabled) {
      onSend(message);
      setMessage("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t bg-background p-4">
      <div className="max-w-4xl mx-auto relative">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="pr-12 resize-none min-h-[60px]"
          disabled={disabled}
          data-testid="input-chat"
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!message.trim() || disabled}
          className="absolute right-2 top-2"
          data-testid="button-send"
        >
          <PaperPlaneIcon className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
