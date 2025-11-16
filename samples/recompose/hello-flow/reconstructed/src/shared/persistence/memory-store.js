/*
 * File: src/shared/persistence/memory-store.js
 *
 * This module acts as an in-memory ledger for records. It supports record creation,
 * updates (patch operations), and retrieval of the most recent entry or all entries.
 *
 * Record Creation Transformation:
 *   - Checks if a custom ID is provided; otherwise, generates one using an internal counter.
 *   - Sets the timestamp to either a provided value or current date/time.
 *   - Inserts record into the internal ledger (an in-memory list).
 *
 * Update Transformation:
 *   - Searches for an existing record by unique identifier.
 *   - Applies patch data if found; returns null if no matching record is found.
 *
 * Retrieval Methods:
 *   - getLast: retrieves the most recent entry or returns null.
 *   - getAll: returns a defensive copy of all records so that external code cannot modify internal state.
 *
 * Defensive Data Handling & Error Cases:
 *   - The "all" method ensures defensive copying.
 *   - Update operations on non-existent records return null gracefully.
 *   - Duplicate custom IDs throw an error.
 */

function getTimestamp() {
  // Returns the current timestamp in ISO format.
  return new Date().toISOString();
}

class MemoryStore {
  constructor() {
    this.ledger = [];
    this.counter = 1; // Starts at 1 for unique identifier generation
  }

  generateUniqueId() {
    // Generates a unique ID string like "run-0001"
    const id = `run-${String(this.counter).padStart(4, '0')}`;
    this.counter += 1;
    return id;
  }

  createRecord(recordData) {
    if (typeof recordData !== 'object' || recordData === null) {
      throw new TypeError('Invalid input: recordData must be an object.');
    }
    
    let id;
    let timestamp;

    // Handle custom ID provided in the input.
    if ('id' in recordData && recordData.id !== undefined && recordData.id !== null) {
      id = recordData.id;
      // Check for duplicate custom IDs to avoid conflicts.
      if (this.ledger.some(record => record.id === id)) {
        throw new Error(`Duplicate custom ID provided: ${id}`);
      }
    } else {
      // Generate a unique ID using the internal counter.
      id = this.generateUniqueId();
    }

    // Set the creation timestamp from provided value or use current date/time.
    timestamp = recordData.timestamp || getTimestamp();

    // Create the new record object with normalized metadata if necessary.
    const newRecord = Object.assign({}, recordData, { id, timestamp });

    // Insert the newly formed record into the internal ledger.
    this.ledger.push(newRecord);

    return newRecord;
  }

  updateRecord(id, patchData) {
    if (typeof id !== 'string') {
      throw new TypeError('Invalid input: id must be a string.');
    }
    if (typeof patchData !== 'object' || patchData === null) {
      throw new TypeError('Invalid input: patchData must be an object.');
    }

    // Find the record with the provided ID.
    const index = this.ledger.findIndex(record => record.id === id);
    if (index === -1) {
      // If no matching record is found, return null gracefully.
      return null;
    }
    
    // Merge the patch data into the existing record.
    this.ledger[index] = Object.assign({}, this.ledger[index], patchData);

    return this.ledger[index];
  }

  getLast() {
    if (this.ledger.length === 0) {
      return null;
    }
    // Return a shallow copy of the last record.
    return Object.assign({}, this.ledger[this.ledger.length - 1]);
  }

  getAll() {
    // Defensive copying: return an array copy with each record copied individually.
    return this.ledger.map(record => Object.assign({}, record));
  }
}

// Module export logic for CommonJS, AMD, or global scope.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MemoryStore;
} else if (typeof define === 'function' && define.amd) {
  // For AMD modules.
  define([], function () { return MemoryStore; });
} else {
  // Otherwise attach to the global scope.
  window.MemoryStore = MemoryStore;
}
