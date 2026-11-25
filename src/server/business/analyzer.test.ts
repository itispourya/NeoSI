import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDeterministicBusinessMetrics } from './analyzer';
import { detectLanguage } from './language';

test('detects English, Persian, Arabic, and Dutch accurately', () => {
  assert.equal(detectLanguage('Analyze Q4 cash runway and overdue invoices'), 'en');
  assert.equal(detectLanguage('تحلیل جریان نقدی و ترازنامه حسابداری شرکت برای این ماه'), 'fa');
  assert.equal(detectLanguage('تحليل التدفق النقدي والميزانية العمومية للشركة'), 'ar');
  assert.equal(detectLanguage('Analyseer de omzet en voorraad voor onze klanten'), 'nl');
});

test('computes double-entry ledger balance, runway, LTV/CAC, and inventory stockout/deadstock risks', () => {
  const metrics = computeDeterministicBusinessMetrics({
    accounting: {
      cashBalance: 120000,
      currentAssets: 180000,
      currentLiabilities: 60000,
      monthlyRevenue: 40000,
      monthlyExpenses: 60000,
      ledgerEntries: [
        { id: 'JE-1', debit: 1000, credit: 0 },
        { id: 'JE-2', debit: 0, credit: 1000 },
        { id: 'JE-3', debit: 500, credit: 0 },
        { id: 'JE-4', debit: 0, credit: 500 },
      ],
    },
    crm: {
      newCustomers: 20,
      churnedCustomers: 5,
      totalActiveCustomers: 100,
      marketingSpend: 4000,
      salesSpend: 2000,
      avgOrderValue: 300,
      grossMarginPct: 80,
    },
    inventory: [
      { sku: 'SKU-FAST', onHand: 15, avgDailySales: 5, leadTimeDays: 7, unitCost: 10, unitPrice: 25, daysSinceLastSale: 1 },
      { sku: 'SKU-DEAD', onHand: 100, avgDailySales: 0, leadTimeDays: 7, unitCost: 20, unitPrice: 40, daysSinceLastSale: 95 },
    ],
  });

  assert.equal(metrics.accounting.ledgerBalanced, true);
  assert.equal(metrics.accounting.workingCapital, 120000);
  assert.equal(metrics.accounting.currentRatio, 3);
  assert.equal(metrics.accounting.cashRunwayMonths, 6);
  assert.equal(metrics.crm.cac, 300);
  assert.equal(metrics.crm.monthlyChurnPct, 5);
  assert.equal(metrics.crm.ltv, 4800);
  assert.equal(metrics.crm.ltvCacRatio, 16);
  assert.equal(metrics.inventory.stockoutRiskSkus.length, 1);
  assert.equal(metrics.inventory.stockoutRiskSkus[0].sku, 'SKU-FAST');
  assert.equal(metrics.inventory.deadStockSkus.length, 1);
  assert.equal(metrics.inventory.deadStockSkus[0].tiedUpCapital, 2000);
});
