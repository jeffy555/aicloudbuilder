/**
 * B5: Managed disk bounds check — API returning fewer items, null retailPrice,
 *     and VM factory function correctness.
 */

import { calculateMonthlyCost, AZURE_PRICING_CONFIG } from '../../../server/azure-pricing-config.js';

describe('calculateMonthlyCost', () => {
  describe('managed disk — bounds and null handling', () => {
    it('does not throw when API returns only 1 item for disk tier', () => {
      const singleItem = { retailPrice: 9.60, skuName: 'P10 LRS' };
      expect(() =>
        calculateMonthlyCost('azurerm_managed_disk', singleItem, {
          storage_account_type: 'Premium_LRS',
          disk_size_gb: 512,
        })
      ).not.toThrow();
    });

    it('returns null when retailPrice is null', () => {
      const nullPriceItem = { retailPrice: null, skuName: 'P10 LRS' };
      const result = calculateMonthlyCost('azurerm_managed_disk', nullPriceItem, {
        storage_account_type: 'Premium_LRS',
        disk_size_gb: 128,
      });
      expect(result).toBeNull();
    });

    it('returns null when retailPrice is undefined', () => {
      const undefinedPriceItem = { skuName: 'P10 LRS' };
      const result = calculateMonthlyCost('azurerm_managed_disk', undefinedPriceItem, {
        storage_account_type: 'Premium_LRS',
        disk_size_gb: 64,
      });
      expect(result).toBeNull();
    });

    it('returns 0 when item is null (resource type not in config)', () => {
      const result = calculateMonthlyCost('azurerm_resource_group', null, {});
      expect(result).toBe(0);
    });
  });

  describe('VM factory function — OS filter correctness', () => {
    it('AZURE_PRICING_CONFIG has entries for all three VM types', () => {
      expect(AZURE_PRICING_CONFIG['azurerm_virtual_machine']).toBeDefined();
      expect(AZURE_PRICING_CONFIG['azurerm_linux_virtual_machine']).toBeDefined();
      expect(AZURE_PRICING_CONFIG['azurerm_windows_virtual_machine']).toBeDefined();
    });

    it('all three VM types share identical buildFilter output for same size', () => {
      const location = 'eastus';
      const attrs = { size: 'Standard_D4s_v3' };
      const filterGeneric = AZURE_PRICING_CONFIG['azurerm_virtual_machine'].buildFilter(attrs, location);
      const filterLinux   = AZURE_PRICING_CONFIG['azurerm_linux_virtual_machine'].buildFilter(attrs, location);
      const filterWindows = AZURE_PRICING_CONFIG['azurerm_windows_virtual_machine'].buildFilter(attrs, location);
      // All three should produce the same OData filter — only selectItem differs
      expect(filterGeneric).toBe(filterLinux);
      expect(filterLinux).toBe(filterWindows);
    });

    it('linux selectItem excludes Windows products', () => {
      const items = [
        { retailPrice: 0.096, productName: 'Virtual Machines D4 v3/D4s v3 Series Windows', skuName: 'D4s v3' },
        { retailPrice: 0.096, productName: 'Virtual Machines D4 v3/D4s v3 Series Linux', skuName: 'D4s v3' },
      ];
      const selected = AZURE_PRICING_CONFIG['azurerm_linux_virtual_machine'].selectItem(items, {});
      expect(selected?.productName).toContain('Linux');
    });

    it('windows selectItem prefers Windows products', () => {
      const items = [
        { retailPrice: 0.192, productName: 'Virtual Machines D4 v3/D4s v3 Series Windows', skuName: 'D4s v3' },
        { retailPrice: 0.096, productName: 'Virtual Machines D4 v3/D4s v3 Series Linux', skuName: 'D4s v3' },
      ];
      const selected = AZURE_PRICING_CONFIG['azurerm_windows_virtual_machine'].selectItem(items, {});
      expect(selected?.productName).toContain('Windows');
    });

    it('calculateMonthlyCost returns positive number for valid VM item', () => {
      const item = { retailPrice: 0.096 };
      const result = calculateMonthlyCost('azurerm_linux_virtual_machine', item, { size: 'Standard_D2s_v3' });
      expect(result).toBeGreaterThan(0);
    });
  });
});
