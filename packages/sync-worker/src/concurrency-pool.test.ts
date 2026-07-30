import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "./concurrency-pool.js";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runWithConcurrency runs up to `concurrency` items in parallel, not serially", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let maxInFlight = 0;

    await runWithConcurrency(
        items,
        3,
        async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await sleep(20);
            inFlight--;
        },
        () => { throw new Error('should not be called'); }
    );

    // With concurrency=3 and 6 items, at least 2 should overlap at once -
    // a fully serial implementation would never exceed 1.
    assert.ok(maxInFlight >= 2, `expected overlapping execution, got max ${maxInFlight}`);
    assert.ok(maxInFlight <= 3, `expected never more than concurrency=3 in flight, got ${maxInFlight}`);
});

test("runWithConcurrency processes every item exactly once", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const seen: number[] = [];

    await runWithConcurrency(items, 4, async (item) => { seen.push(item); }, () => {});

    assert.deepEqual(seen.slice().sort((a, b) => a - b), items);
});

test("runWithConcurrency isolates failures - one failing item doesn't stop the rest", async () => {
    const items = [1, 2, 3, 4, 5];
    const errors: number[] = [];

    const result = await runWithConcurrency(
        items,
        2,
        async (item) => {
            if (item === 3) throw new Error('boom');
        },
        (item) => { errors.push(item); }
    );

    assert.equal(result.synced, 4);
    assert.equal(result.failed, 1);
    assert.deepEqual(errors, [3]);
});

test("runWithConcurrency clamps worker count to the item count when concurrency is higher", async () => {
    const items = [1, 2];
    let started = 0;
    let maxInFlight = 0;

    await runWithConcurrency(
        items,
        10,
        async () => {
            started++;
            maxInFlight = Math.max(maxInFlight, started);
            await sleep(10);
            started--;
        },
        () => {}
    );

    assert.ok(maxInFlight <= 2, `expected at most 2 workers for 2 items, got ${maxInFlight}`);
});

test("runWithConcurrency handles an empty item list", async () => {
    const result = await runWithConcurrency([], 4, async () => {}, () => {});
    assert.deepEqual(result, { synced: 0, failed: 0 });
});
