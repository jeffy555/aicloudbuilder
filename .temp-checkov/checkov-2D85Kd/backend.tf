terraform {
  backend "azurerm" {
    resource_group_name  = "terraform-state-rg"
    storage_account_name = "terraformstate"
    container_name       = "terraformstate"
    key                  = "terraform.tfstate"
    use_azuread_auth     = true
  }
}