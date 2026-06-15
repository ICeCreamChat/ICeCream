export function createRenderScheduler({
    scheduleFrame = callback => requestAnimationFrame(callback),
    cancelFrame = handle => cancelAnimationFrame(handle),
    onFlush = () => {},
} = {}) {
    const pending = new Set();
    let handle = null;

    const flush = () => {
        handle = null;
        if (!pending.size) return;
        const scopes = [...pending];
        pending.clear();
        onFlush(scopes);
    };

    return {
        request(scope = 'smart-shell') {
            pending.add(scope);
            if (handle === null) handle = scheduleFrame(flush);
        },
        flush,
        cancel() {
            if (handle !== null) cancelFrame(handle);
            handle = null;
            pending.clear();
        },
        pending() {
            return [...pending];
        },
    };
}

