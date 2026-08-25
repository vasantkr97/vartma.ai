# Reservation rules

`ReservationService.reserve(lines)` accepts `{sku, quantity}` lines. Quantities are positive
integers. Duplicate SKUs are combined. Every SKU must exist and have enough stock before any stock
changes. On success, decrement each total and return normalized lines sorted by SKU. Throw
`UnknownSkuError` or `InsufficientStockError` with the offending SKU. Empty input succeeds.
