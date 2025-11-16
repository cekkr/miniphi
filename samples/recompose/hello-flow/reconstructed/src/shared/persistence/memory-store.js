"use strict";

class MemoryStore {
  constructor() {
    this.records = [];
    this.counter = 0;
  }

  // Helper: Generate a unique id using a counter and prefix "run-"
  generateId() {
    this.counter++;
    return "run-" + String(this.counter).padStart(4, "0");
  }

  // Create a new record.
  create(record) {
    if (typeof record !== "object" || record === null) {
      console.warn("MemoryStore.create: Expected an object but received", record, ". Defaulting to empty object.");
      record = {};
    }
    
    // Generate id if missing
    if (!record.hasOwnProperty("id")) {
      record.id = this.generateId();
    }
    
    // Set createdAt timestamp if not provided.
    if (!record.hasOwnProperty("createdAt")) {
      record.createdAt = Date.now();
    }
    
    // Store the record internally.
    this.records.push(record);
    return record;
  }

  // Update an existing record identified by id using a patch object.
  update(id, patch) {
    const record = this.records.find(r => r.id === id);
    if (!record) {
      return null; // Record not found.
    }
    
    // Merge the patch into the existing record.
    Object.assign(record, patch);
    return record;
  }

  // Retrieve the most recently added record (last one).
  last() {
    if (this.records.length === 0) {
      return undefined;
    }
    return this.records[this.records.length - 1];
  }

  // Return an immutable copy of all records.
  all() {
    const clonedRecords = [...this.records];
    return this._deepFreeze(clonedRecords);
  }

  // Helper: Recursively freeze objects to create an immutable snapshot.
  _deepFreeze(obj) {
    try {
      Object.freeze(obj);
    } catch (e) {
      console.warn("MemoryStore._deepFreeze: Could not freeze object", obj, e);
    }
    const propNames = Object.getOwnPropertyNames(obj);
    for (let name of propNames) {
      let value = obj[name];
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        this._deepFreeze(value);
      }
    }
    return obj;
  }
}

module.exports = MemoryStore;
