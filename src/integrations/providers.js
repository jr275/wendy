/**
 * WENDY PROVIDER ADAPTER BOUNDARIES
 * Pure abstract interfaces decoupling Wendy Core from specific vendor APIs
 * (Google Workspace, Microsoft 365, IMAP/CalDAV, Local Sandboxes).
 */

/**
 * @typedef {Object} ProviderAuthContext
 * @property {string} principalId - The executive user identifier
 * @property {string} tenantId - Corporate tenant / domain
 * @property {Record<string, any>} credentials - OAuth tokens or service credentials
 */

/**
 * Abstract Calendar Provider Contract
 */
export class CalendarProvider {
  /**
   * @param {Date} timeMin
   * @param {Date} timeMax
   * @returns {Promise<Array<import('../types/domain.js').CalendarEvent>>}
   */
  async listEvents(timeMin, timeMax) {
    throw new Error('CalendarProvider.listEvents must be implemented by provider adapter');
  }

  /**
   * @param {string} externalEventId
   * @returns {Promise<import('../types/domain.js').CalendarEvent>}
   */
  async getEvent(externalEventId) {
    throw new Error('CalendarProvider.getEvent must be implemented by provider adapter');
  }

  /**
   * Staging draft/proposals (Level 1)
   */
  async stageEventMutation(mutationPlan) {
    throw new Error('CalendarProvider.stageEventMutation must be implemented by provider adapter');
  }

  /**
   * Authorized execution (Level 3)
   */
  async executeEventMutation(approvedActionEnvelope, idempotencyKey) {
    throw new Error('CalendarProvider.executeEventMutation must be implemented by provider adapter');
  }

  /**
   * Subscribe to real-time changes
   */
  async registerWebhook(webhookCallbackUrl) {
    throw new Error('CalendarProvider.registerWebhook must be implemented by provider adapter');
  }
}

/**
 * Abstract Email Provider Contract
 */
export class EmailProvider {
  /**
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array<import('../types/domain.js').Email>>}
   */
  async searchMessages(query, limit = 20) {
    throw new Error('EmailProvider.searchMessages must be implemented by provider adapter');
  }

  /**
   * @param {string} messageId
   * @returns {Promise<import('../types/domain.js').Email>}
   */
  async getMessage(messageId) {
    throw new Error('EmailProvider.getMessage must be implemented by provider adapter');
  }

  /**
   * Staging draft (Level 1 - zero external side effects)
   */
  async stageDraft({ to, subject, bodyText, threadId }) {
    throw new Error('EmailProvider.stageDraft must be implemented by provider adapter');
  }

  /**
   * Authorized dispatch (Level 3 - requires cryptographic approval sign-off)
   * Must enforce idempotency.
   */
  async dispatchAuthorizedEmail({ approvedActionId, to, subject, bodyText, idempotencyKey }) {
    throw new Error('EmailProvider.dispatchAuthorizedEmail must be implemented by provider adapter');
  }

  /**
   * Post-execution delivery verification
   */
  async verifyDelivery(dispatchReceipt) {
    throw new Error('EmailProvider.verifyDelivery must be implemented by provider adapter');
  }

  /**
   * Register push notifications (e.g. Gmail PubSub)
   */
  async registerPushNotifications(topicArnOrWebhook) {
    throw new Error('EmailProvider.registerPushNotifications must be implemented by provider adapter');
  }
}

/**
 * Abstract Contacts Provider Contract
 */
export class ContactsProvider {
  /**
   * @param {string} query
   * @returns {Promise<Array<import('../types/domain.js').Person>>}
   */
  async searchContacts(query) {
    throw new Error('ContactsProvider.searchContacts must be implemented by provider adapter');
  }

  /**
   * @param {string} contactId
   * @returns {Promise<import('../types/domain.js').Person>}
   */
  async getContact(contactId) {
    throw new Error('ContactsProvider.getContact must be implemented by provider adapter');
  }

  /**
   * Sync directory changes
   */
  async syncDirectoryChanges(syncToken) {
    throw new Error('ContactsProvider.syncDirectoryChanges must be implemented by provider adapter');
  }
}

/**
 * Abstract Drive & Document Provider Contract
 */
export class DriveProvider {
  /**
   * @param {string} query
   * @returns {Promise<Array<{ id: string, name: string, mimeType: string, modifiedAt: string }>>}
   */
  async searchFiles(query) {
    throw new Error('DriveProvider.searchFiles must be implemented by provider adapter');
  }

  /**
   * Extracts text / AST from document
   * @param {string} fileId
   * @returns {Promise<{ contentText: string, metadata: Record<string, any> }>}
   */
  async extractDocumentContent(fileId) {
    throw new Error('DriveProvider.extractDocumentContent must be implemented by provider adapter');
  }
}
