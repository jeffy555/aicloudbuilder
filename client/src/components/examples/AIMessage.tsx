import AIMessage from '../AIMessage';

export default function AIMessageExample() {
  return (
    <div className="p-6">
      <AIMessage message="Hey! Before we dive into your Terraform setup, which repository provider would you like to use — GitHub or Azure DevOps? I'll route everything accordingly." />
    </div>
  );
}
