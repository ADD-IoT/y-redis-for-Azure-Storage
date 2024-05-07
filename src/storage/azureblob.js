import * as Y from 'yjs';
import * as random from 'lib0/random';
import * as promise from 'lib0/promise';
import * as env from 'lib0/environment';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

/**
 * @typedef {import('../storage.js').AbstractStorage} AbstractStorage
 */

/**
 * Create Azure Blob storage instance.
 * @param {string} containerName - Name of the Azure container.
 */
export const createazureblobStorage = (containerName) => {
  const accountName = env.ensureConf('azure-account-name');
  const accountKey = env.ensureConf('azure-account-key');
  const protocol = env.getConf('azure-protocol') || 'https';
  const endpoint = `${protocol}://${accountName}.blob.core.windows.net`;

  const sharedKeyCredential = new StorageSharedKeyCredential(
    accountName,
    accountKey
  );
  const blobServiceClient = new BlobServiceClient(
    endpoint,
    sharedKeyCredential
  );
  return new azureblobStorage(containerName, blobServiceClient);
};

/**
 * Generate a blob name for Azure Blob storage.
 * @param {string} room
 * @param {string} docid
 * @param {string} r - Random UUID.
 */
export const encodeBlobName = (room, docid, r = random.uuidv4()) =>
  `${encodeURIComponent(room)}/${encodeURIComponent(docid)}/${r}`;

/**
 * Decode a blob name from Azure Blob storage.
 * @param {string} blobName
 */
export const decodeBlobName = (blobName) => {
  const match = blobName.match(/(.*)\/(.*)\/(.*)$/);
  if (match == null) {
    throw new Error('Malformed y:room stream name!');
  }
  return {
    room: decodeURIComponent(match[1]),
    docid: decodeURIComponent(match[2]),
    r: match[3],
  };
};

/**
 * @implements {AbstractStorage}
 */
class azureblobStorage {
  /**
   * @param {string} containerName
   * @param {BlobServiceClient} blobServiceClient
   */
  constructor(containerName, blobServiceClient) {
    this.containerClient = blobServiceClient.getContainerClient(containerName);
  }

  /**
   * Persist a Yjs document in Azure Blob storage.
   * @param {string} room
   * @param {string} docname
   * @param {Y.Doc} ydoc
   */
  async persistDoc(room, docname, ydoc) {
    const blobName = encodeBlobName(room, docname);
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const updateBuffer = Buffer.from(Y.encodeStateAsUpdateV2(ydoc));
    await blockBlobClient.upload(updateBuffer, updateBuffer.length);
  }

  /**
   * Retrieve a Yjs document from Azure Blob storage.
   * @param {string} room
   * @param {string} docname
   */
  async retrieveDoc(room, docname) {
    const prefix = encodeBlobName(room, docname, '');
    let iter = this.containerClient.listBlobsFlat({ prefix });
    let references = [];
    let updates = [];

    for await (const blob of iter) {
      references.push(blob.name);
      const blockBlobClient = this.containerClient.getBlockBlobClient(
        blob.name
      );
      const downloadBlockBlobResponse = await blockBlobClient.download(0);

      // Check if readableStreamBody is not undefined before using it
      if (downloadBlockBlobResponse.readableStreamBody) {
        const update = await new Promise((resolve, reject) => {
          /**
           * @type {any[] | readonly Uint8Array[]}
           */
          const chunks = [];
          downloadBlockBlobResponse.readableStreamBody?.on('data', (/** @type {any} */ chunk) => {
            // @ts-ignore
            chunks.push(chunk);
          });
          downloadBlockBlobResponse.readableStreamBody?.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
          downloadBlockBlobResponse.readableStreamBody?.on('error', reject);
        });
        updates.push(update);
      } else {
        // Handle the case where readableStreamBody is undefined
        // For example, log an error or throw an exception
        console.error(
          'Failed to download blob as readable stream body was undefined.'
        );
      }
    }

    if (updates.length === 0) {
      return null; // No updates found, perhaps handle this case explicitly
    }

    return { doc: Y.mergeUpdatesV2(updates), references };
  }

  /**
   * Remove references from Azure Blob storage.
   * @param {string} _room - Room identifier, not used in current method but required by interface.
   * @param {string} _docname - Document name, not used in current method but required by interface.
   * @param {string[]} storeReferences - Array of storage references to delete.
   * @return {Promise<void>}
   */
  async deleteReferences(_room, _docname, storeReferences) {
    for (const ref of storeReferences) {
      const blockBlobClient = this.containerClient.getBlockBlobClient(ref);
      await blockBlobClient.delete();
    }
  }

  async destroy() {
    // Optional clean-up actions
  }

  /**
   * Retrieve a state vector for a Yjs document from Azure Blob storage.
   * @param {string} room
   * @param {string} docname
   * @returns {Promise<Uint8Array | null>} - Returns the state vector as a Uint8Array, or null if not found.
   */
  async retrieveStateVector(room, docname) {
    const stateVectorBlobName = encodeBlobName(room, docname, 'state_vector');
    const blockBlobClient =
      this.containerClient.getBlockBlobClient(stateVectorBlobName);
    try {
      const downloadResponse = await blockBlobClient.download(0);
      if (downloadResponse.readableStreamBody) {
        const stateVector = await new Promise((resolve, reject) => {
          /**
           * @type {any[] | readonly Uint8Array[]}
           */
          const chunks = [];
          downloadResponse.readableStreamBody?.on('data', (/** @type {any} */ chunk) =>
            // @ts-ignore
            chunks.push(chunk)
          );
          downloadResponse.readableStreamBody?.on('end', () =>
            resolve(Buffer.concat(chunks))
          );
          downloadResponse.readableStreamBody?.on('error', reject);
        });
        return stateVector;
      } else {
        console.error(
          'Failed to download state vector as readable stream body was undefined.'
        );
        return null;
      }
    } catch (error) {
      console.error(
        `Failed to retrieve state vector for document: ${docname}`,
        error
      );
      return null;
    }
  }
}
