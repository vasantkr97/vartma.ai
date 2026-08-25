import { InsufficientStockError, UnknownSkuError } from "./errors.mjs";

export class ReservationService {
  constructor(catalog) {
    this.catalog = catalog;
  }

  reserve(lines) {
    const totals = new Map();
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new RangeError("quantity must be a positive integer");
      }
      totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
    }
    const normalized = [...totals.entries()]
      .map(([sku, quantity]) => ({ sku, quantity }))
      .sort((left, right) => left.sku.localeCompare(right.sku));
    for (const line of normalized) {
      if (!this.catalog.has(line.sku)) throw new UnknownSkuError(line.sku);
      if (this.catalog.stock(line.sku) < line.quantity) {
        throw new InsufficientStockError(line.sku);
      }
    }
    for (const line of normalized) {
      this.catalog.setStock(line.sku, this.catalog.stock(line.sku) - line.quantity);
    }
    return normalized;
  }
}
