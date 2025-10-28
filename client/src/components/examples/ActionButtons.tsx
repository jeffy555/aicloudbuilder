import ActionButtons from '../ActionButtons';
import { useState } from 'react';

export default function ActionButtonsExample() {
  const [loading, setLoading] = useState(false);

  const handleApprove = () => {
    setLoading(true);
    console.log('Approved!');
    setTimeout(() => setLoading(false), 2000);
  };

  return (
    <div className="p-6">
      <ActionButtons
        onApprove={handleApprove}
        onCancel={() => console.log('Cancelled')}
        loading={loading}
      />
    </div>
  );
}
