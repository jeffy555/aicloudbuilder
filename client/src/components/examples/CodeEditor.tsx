import CodeEditor from '../CodeEditor';
import { useState } from 'react';

export default function CodeEditorExample() {
  const [files, setFiles] = useState([
    {
      name: 'main.tf',
      content: `resource "azurerm_resource_group" "example" {
  name     = "example-resources"
  location = "East US"
}

resource "azurerm_storage_account" "example" {
  name                     = "examplestorageacct"
  resource_group_name      = azurerm_resource_group.example.name
  location                 = azurerm_resource_group.example.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}`
    },
    {
      name: 'variables.tf',
      content: `variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
  default     = "example-resources"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "East US"
}`
    },
    {
      name: 'terraform.tfvars',
      content: `resource_group_name = "example-resources"
location           = "East US"`
    }
  ]);

  const handleFileChange = (fileName: string, content: string) => {
    setFiles(files.map(f => f.name === fileName ? { ...f, content } : f));
  };

  return (
    <div className="p-6 max-w-4xl">
      <CodeEditor files={files} onFileChange={handleFileChange} />
    </div>
  );
}
