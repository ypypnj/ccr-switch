'use strict';

function stableCanonical(value) {
  function sanitize(item) {
    if (item === null || typeof item === 'undefined') return null;
    if (typeof item === 'function' || typeof item === 'symbol') return null;
    if (Array.isArray(item)) return item.map(sanitize);
    if (typeof item === 'object') {
      var output = {};
      Object.keys(item).sort().forEach(function(key) { output[key] = sanitize(item[key]); });
      return output;
    }
    return item;
  }
  return JSON.stringify(sanitize(value));
}

function createReceiptIndex(options) {
  options = options || {};
  var ttlMs = options.ttlMs || 5 * 60 * 1000;
  var maxEntries = options.maxEntries || 2048;
  var now = options.now || Date.now;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || !Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('invalid receipt index bounds');
  var entries = new Map();

  function prune() {
    var time = now();
    entries.forEach(function(entry, id) { if (entry.expiresAt <= time) entries.delete(id); });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  function put(messageId, receipt) {
    prune();
    var canonical = stableCanonical(receipt);
    var existing = entries.get(messageId);
    if (existing) {
      if (existing.conflict) return { status: 'conflict' };
      if (existing.canonical === canonical) return { status: 'idempotent' };
      entries.set(messageId, { conflict: true, expiresAt: now() + ttlMs });
      return { status: 'conflict' };
    }
    entries.set(messageId, { receipt: receipt, canonical: canonical, conflict: false, expiresAt: now() + ttlMs });
    prune();
    return { status: 'stored' };
  }
  function get(messageId) {
    prune();
    var entry = entries.get(messageId);
    if (!entry) return { status: 'missing' };
    return entry.conflict ? { status: 'conflict' } : { status: 'found', receipt: entry.receipt };
  }
  return { put: put, get: get };
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function createSSEFrameCollector() {
  var buffer = '';
  return {
    feed: function(chunk) {
      buffer += chunk;
      var normalized = buffer.replace(/\r\n/g, '\n');
      var frames = normalized.split('\n\n');
      buffer = frames.pop();
      return frames;
    }
  };
}

function parseSSEFrameData(frame) {
  var data = frame.split('\n').filter(function(line) { return line.startsWith('data:'); }).map(function(line) {
    return line.slice(5).replace(/^ /, '');
  }).join('\n');
  if (!data) return null;
  return JSON.parse(data);
}

module.exports = { createReceiptIndex: createReceiptIndex, isLoopbackAddress: isLoopbackAddress, createSSEFrameCollector: createSSEFrameCollector, parseSSEFrameData: parseSSEFrameData };
