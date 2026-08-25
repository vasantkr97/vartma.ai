# Durable queue requirements

The API accepts jobs for one tenant and returns immediately. Workers may crash after an external
side effect but before acknowledgement. Each tenant requires FIFO start order, while global work
runs concurrently. Traffic can exceed capacity by 20x for ten minutes. Operators need bounded
retries, poison-job isolation, traceability, disaster recovery, and a way to replay safely.
