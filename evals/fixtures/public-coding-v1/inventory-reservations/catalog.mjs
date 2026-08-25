export class Catalog {
  #stock;
  constructor(entries = {}) {
    this.#stock = new Map(Object.entries(entries));
  }
  has(sku) {
    return this.#stock.has(sku);
  }
  stock(sku) {
    return this.#stock.get(sku);
  }
  setStock(sku, quantity) {
    this.#stock.set(sku, quantity);
  }
}
