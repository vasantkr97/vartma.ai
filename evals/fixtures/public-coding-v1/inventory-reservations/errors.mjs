export class UnknownSkuError extends Error {
  constructor(sku) {
    super(`Unknown SKU: ${sku}`);
    this.sku = sku;
  }
}

export class InsufficientStockError extends Error {
  constructor(sku) {
    super(`Insufficient stock: ${sku}`);
    this.sku = sku;
  }
}
