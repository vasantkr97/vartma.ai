import assert from "node:assert/strict";
import { Catalog } from "../catalog.mjs";
import { InsufficientStockError, UnknownSkuError } from "../errors.mjs";
import { ReservationService } from "../reservation-service.mjs";

const catalog = new Catalog({ a: 5, b: 2 });
const service = new ReservationService(catalog);
assert.deepEqual(
  service.reserve([
    { sku: "b", quantity: 1 },
    { sku: "a", quantity: 2 },
    { sku: "a", quantity: 1 },
  ]),
  [
    { sku: "a", quantity: 3 },
    { sku: "b", quantity: 1 },
  ],
);
assert.equal(catalog.stock("a"), 2);
assert.equal(catalog.stock("b"), 1);
assert.throws(
  () =>
    service.reserve([
      { sku: "a", quantity: 1 },
      { sku: "missing", quantity: 1 },
    ]),
  UnknownSkuError,
);
assert.equal(catalog.stock("a"), 2);
assert.throws(() => service.reserve([{ sku: "a", quantity: 3 }]), InsufficientStockError);
assert.equal(catalog.stock("a"), 2);
assert.throws(() => service.reserve([{ sku: "a", quantity: 0 }]), RangeError);
assert.deepEqual(service.reserve([]), []);
