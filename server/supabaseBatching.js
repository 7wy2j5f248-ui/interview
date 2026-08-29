export const DATABASE_PAGE_SIZE = 1000;
export const IN_QUERY_CHUNK_SIZE = 100;
export const DEFAULT_QUERY_CONCURRENCY = 8;

export function createTaskLimiter(
    maximumConcurrency = DEFAULT_QUERY_CONCURRENCY
) {
    const limit = Math.max(1, Number(maximumConcurrency) || 1);
    const waiting = [];
    let active = 0;

    function runNext() {
        while (active < limit && waiting.length) {
            const { task, resolve, reject } = waiting.shift();
            active += 1;
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    active -= 1;
                    runNext();
                });
        }
    }

    return task => new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        runNext();
    });
}

export async function allRows(
    queryFactory,
    message,
    pageSize = DATABASE_PAGE_SIZE
) {
    const rows = [];
    const safePageSize = Math.max(1, Number(pageSize) || DATABASE_PAGE_SIZE);

    for (let from = 0; ; from += safePageSize) {
        const { data, error } = await queryFactory().range(
            from,
            from + safePageSize - 1
        );
        if (error) throw new Error(message, { cause: error });
        rows.push(...(data || []));
        if (!data || data.length < safePageSize) return rows;
    }
}

export async function rowsForIds(
    ids,
    queryFactory,
    message,
    {
        schedule = task => task(),
        chunkSize = IN_QUERY_CHUNK_SIZE
    } = {}
) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    const safeChunkSize = Math.max(1, Number(chunkSize) || IN_QUERY_CHUNK_SIZE);
    const chunks = [];

    for (let index = 0; index < unique.length; index += safeChunkSize) {
        chunks.push(unique.slice(index, index + safeChunkSize));
    }

    const groups = await Promise.all(chunks.map(chunk => schedule(
        () => allRows(() => queryFactory(chunk), message)
    )));
    return groups.flat();
}
