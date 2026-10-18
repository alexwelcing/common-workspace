const DATABASE = 'common-spatial-beta';
const VERSION = 2;
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_SEGMENTS = 4096;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('The browser could not read the spatial workspace.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('The browser could not save the spatial workspace.'));
  });
}

/** Browser-owned storage. A failed write never reports a successful save. */
export async function openSpatialStorage({ indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) throw new Error('This browser cannot save spatial workspaces. Keep this tab open and download an archive before leaving.');
  const request = indexedDB.open(DATABASE, VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('workspaces')) database.createObjectStore('workspaces', { keyPath: 'id' });
    if (!database.objectStoreNames.contains('documents')) {
      const documents = database.createObjectStore('documents', { keyPath: ['workspace', 'id'] });
      documents.createIndex('workspace', 'workspace');
    }
    // Version 1 snapshots stay untouched. New edits are small independent
    // segments; compaction replaces a snapshot without discarding Loro history.
    if (!database.objectStoreNames.contains('updates')) {
      const updates = database.createObjectStore('updates', { keyPath: ['workspace', 'document', 'id'] });
      updates.createIndex('workspace', 'workspace');
    }
  };
  const database = await new Promise((resolve, reject) => {
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('The browser could not open spatial storage.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close older Common tabs to allow spatial storage to open.'));
    };
  });
  let closed = false;
  database.onversionchange = () => {
    closed = true;
    database.close();
  };
  function transaction(names, mode) {
    if (closed) throw new Error('Spatial storage changed in another tab. Reload before making more changes.');
    return database.transaction(names, mode);
  }
  return {
    async load(id) {
      // Read metadata, snapshots, and journal segments in the same transaction so
      // a compaction in another tab cannot produce a mixed generation on load.
      const tx = transaction(['workspaces', 'documents', 'updates'], 'readonly');
      const done = transactionDone(tx);
      const [metadata, snapshots, segments] = await Promise.all([
        requestResult(tx.objectStore('workspaces').get(id)),
        requestResult(tx.objectStore('documents').index('workspace').getAll(id)),
        requestResult(tx.objectStore('updates').index('workspace').getAll(id)),
        done,
      ]);
      if (!metadata) return null;
      const documents = new Map(snapshots.map(({ id: documentId, bytes, token }) => [
        documentId,
        { id: documentId, bytes, token: token || 'legacy', segments: [] },
      ]));
      let totalBytes = 0;
      for (const document of documents.values()) {
        if (!(document.bytes instanceof Uint8Array) || document.bytes.length > MAX_DOCUMENT_BYTES) {
          throw new Error('The saved workspace contains an oversized snapshot. Download an archive before continuing.');
        }
        totalBytes += document.bytes.length;
      }
      for (const segment of segments) {
        if (!(segment.bytes instanceof Uint8Array) || segment.bytes.length > MAX_DOCUMENT_BYTES) {
          throw new Error('The saved workspace contains an oversized edit segment.');
        }
        if (!documents.has(segment.document)) {
          documents.set(segment.document, { id: segment.document, bytes: null, segments: [] });
        }
        const document = documents.get(segment.document);
        document.segments.push({ id: segment.id, bytes: segment.bytes });
        totalBytes += segment.bytes.length;
        if (document.segments.length > MAX_DOCUMENT_SEGMENTS || totalBytes > MAX_WORKSPACE_BYTES) {
          throw new Error('The saved edit journal exceeds the beta storage limit. Keep this tab open and download an archive.');
        }
      }
      if (totalBytes > MAX_WORKSPACE_BYTES) throw new Error('This saved workspace exceeds the 64 MiB beta storage limit.');
      return { metadata, documents: [...documents.values()] };
    },
    async save(id, { metadata, documents = [], updates = [], removeSegments = [] }) {
      const tx = transaction(['workspaces', 'documents', 'updates'], 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore('workspaces').put({ ...metadata, id });
      for (const document of documents) {
        tx.objectStore('documents').put({
          workspace: id,
          id: document.id,
          bytes: document.bytes,
          token: document.token || crypto.randomUUID(),
        });
      }
      // Delete only segments included in the new snapshot. Segments written
      // concurrently by another tab survive even without the Web Locks API.
      for (const segment of removeSegments) tx.objectStore('updates').delete([id, segment.document, segment.id]);
      for (const update of updates) {
        tx.objectStore('updates').put({ workspace: id, document: update.document, id: update.id, bytes: update.bytes });
      }
      await done;
    },
    async list() {
      const tx = transaction(['workspaces'], 'readonly');
      const done = transactionDone(tx);
      const [records] = await Promise.all([requestResult(tx.objectStore('workspaces').getAll()), done]);
      return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async remove(id) {
      const tx = transaction(['workspaces', 'documents', 'updates'], 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore('workspaces').delete(id);
      for (const name of ['documents', 'updates']) {
        const request = tx.objectStore(name).index('workspace').openKeyCursor(id);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      await done;
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
