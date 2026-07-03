const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

class ReplayBuffer {
    constructor(options = {}) {
        this.maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
        this.maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MS;
        this.entries = [];
        this.nextSeq = 1;
        this.bufferedBytes = 0;
    }

    append(data) {
        const buffer = Buffer.from(data);
        const entry = {
            seq: this.nextSeq,
            data: buffer,
            bytes: buffer.length,
            ts: Date.now()
        };

        this.nextSeq += 1;
        this.entries.push(entry);
        this.bufferedBytes += entry.bytes;
        this.trim();

        return entry;
    }

    getLatestSeq() {
        return this.nextSeq - 1;
    }

    getEarliestSeq() {
        this.trim();
        return this.entries[0] ? this.entries[0].seq : this.nextSeq;
    }

    hasMissed(requestedSeq) {
        this.trim();
        return requestedSeq <= this.getLatestSeq() && requestedSeq < this.getEarliestSeq();
    }

    getAfter(seq) {
        this.trim();
        return this.entries.filter(entry => entry.seq > seq);
    }

    trim() {
        const cutoff = Date.now() - this.maxAgeMs;

        while (this.entries.length > 0 && this.entries[0].ts < cutoff) {
            const removed = this.entries.shift();
            this.bufferedBytes -= removed.bytes;
        }

        while (this.entries.length > 0 && this.bufferedBytes > this.maxBytes) {
            const removed = this.entries.shift();
            this.bufferedBytes -= removed.bytes;
        }
    }
}

module.exports = {
    DEFAULT_MAX_AGE_MS,
    DEFAULT_MAX_BYTES,
    ReplayBuffer
};
