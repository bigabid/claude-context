/**
 * Runs `task` over every item in `items` with at most `concurrency` in
 * flight at once. Each worker pulls the next item off the shared queue as
 * soon as it finishes, so a few slow/large items don't stall the whole run
 * waiting for a fixed-size batch to complete (unlike chunking the array into
 * batches of `concurrency` and awaiting each batch in turn).
 *
 * A failing `task` call is caught per-item and does not stop the pool - the
 * caller gets synced/failed counts rather than a rejected promise.
 */
export async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<void>,
    onError: (item: T, error: unknown) => void
): Promise<{ synced: number; failed: number }> {
    let nextIndex = 0;
    let synced = 0;
    let failed = 0;

    async function worker(): Promise<void> {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            const item = items[index];
            try {
                await task(item);
                synced++;
            } catch (error) {
                onError(item, error);
                failed++;
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { synced, failed };
}
