import ChatInput from '../ChatInput';

export default function ChatInputExample() {
  return (
    <ChatInput 
      onSend={(msg) => console.log('Message sent:', msg)} 
      placeholder="Describe your Terraform setup..."
    />
  );
}
