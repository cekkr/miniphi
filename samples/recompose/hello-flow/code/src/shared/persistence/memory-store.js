export default class MemoryStore {
  constructor() {
    this.records = [];
    this.counter = 0;
  }

  create(entry = {}) {
    this.counter += 1;
    const id = entry.id ?? `run-${this.counter.toString().padStart(4, "0")}`;
    const record = {
      id,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      ...entry,
    };
    this.records.push(record);
    return record;
  }

  update(id, patch = {}) {
    const record = this.records.find((item) => item.id === id);
    if (!record) {
      return null;
    }
    Object.assign(record, patch);
    return record;
  }

  last() {
    return this.records[this.records.length - 1] ?? null;
  }

  all() {
    return [...this.records];
  }
}
