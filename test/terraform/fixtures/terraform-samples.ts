/**
 * Sample Terraform content for testing
 */

export const validMainTf = `
resource "azurerm_resource_group" "main" {
  name     = "example-resources"
  location = "eastus"
}

resource "azurerm_storage_account" "main" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}
`;

export const validMainTfMultiResource = `
resource "azurerm_resource_group" "main" {
  name     = "example-resources"
  location = "eastus"
}

resource "azurerm_storage_account" "main" {
  name                     = "examplestorage"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_virtual_network" "main" {
  name                = "example-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "internal" {
  name                 = "internal"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.2.0/24"]
}

resource "azurerm_key_vault" "main" {
  name                = "example-keyvault"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
}

resource "azurerm_app_service_plan" "main" {
  name                = "example-asp"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  sku {
    tier = "Standard"
    size = "S1"
  }
}
`;

export const validVariablesTf = `
variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "storage_account_name" {
  description = "Name of the storage account"
  type        = string
}
`;

export const validTfvars = `
resource_group_name  = "my-rg"
location             = "westus2"
storage_account_name = "mystorageacct"
`;

export const mainTfWithVariables = `
resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_storage_account" "main" {
  name                     = var.storage_account_name
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = var.account_tier
  account_replication_type = var.replication_type
}
`;

export const mainTfWithModules = `
module "storage" {
  source = "./modules/storage"

  name                = "example"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

module "network" {
  source = "./modules/network"

  name                = "example-vnet"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}
`;

export const invalidTerraformContent = `
this is not valid terraform code
it has no resource blocks
just random text
`;

export const mainTfWithHardcodedValues = `
resource "azurerm_resource_group" "main" {
  name     = "my-production-rg"
  location = "eastus"
}

resource "azurerm_storage_account" "main" {
  name                     = "prodstorageacct12345"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "GRS"
}
`;

export const sampleMermaidOutput = `graph TB
    azurerm_resource_group_main[Resource Group<br/>main]

    subgraph "Storage"
        azurerm_storage_account_main[Storage Account<br/>main]
    end

    azurerm_resource_group_main --> azurerm_storage_account_main
`;

export const awsMainTf = `
resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"

  tags = {
    Name = "HelloWorld"
  }
}

resource "aws_s3_bucket" "data" {
  bucket = "my-data-bucket"
}
`;

export const gcpMainTf = `
resource "google_compute_instance" "default" {
  name         = "test"
  machine_type = "e2-medium"
  zone         = "us-central1-a"
}

resource "google_storage_bucket" "default" {
  name     = "my-bucket"
  location = "US"
}
`;

export const multipleResourcesSameType = `
resource "azurerm_storage_account" "storage1" {
  name                     = "storage1"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_account" "storage2" {
  name                     = "storage2"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_account" "storage3" {
  name                     = "storage3"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}
`;
