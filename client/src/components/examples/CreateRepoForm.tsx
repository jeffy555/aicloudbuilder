import CreateRepoForm from '../CreateRepoForm';

export default function CreateRepoFormExample() {
  return (
    <div className="p-6 max-w-md">
      <CreateRepoForm 
        onSubmit={(name, desc) => console.log('Create repo:', name, desc)}
      />
    </div>
  );
}
