export class ReservationService {
  constructor(catalog) {
    this.catalog = catalog;
  }

  reserve(lines) {
    for (const line of lines) {
      this.catalog.setStock(line.sku, this.catalog.stock(line.sku) - line.quantity);
    }
    return lines;
  }
}
