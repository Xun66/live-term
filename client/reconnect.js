const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

function getLinearBackoffDelay(attempt, options = {}) {
    const baseDelayMs = options.baseDelayMs || DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = options.maxDelayMs || DEFAULT_MAX_DELAY_MS;

    return Math.min(Math.max(attempt, 1) * baseDelayMs, maxDelayMs);
}

module.exports = {
    getLinearBackoffDelay
};
