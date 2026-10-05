/**
 * AG-UI INTERACTION PROTOCOL IMPLEMENTATION
 * Implements agentic streaming, backend tool progress rendering, and HITL suspensions.
 */
export class AguiProtocol {
  /**
   * Formats a SSE message payload
   */
  static formatSse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /**
   * Generates a backend tool progress state envelope
   */
  static createToolProgressEnvelope({ toolName, userFacingMessage, status = 'IN_PROGRESS' }) {
    return {
      type: 'AGUI_TOOL_PROGRESS',
      timestamp: new Date().toISOString(),
      toolName,
      status, // IN_PROGRESS, COMPLETED, SUSPENDED
      userFacingMessage
    };
  }

  /**
   * Generates a HITL Interrupt Suspension envelope
   */
  static createHitlSuspensionEnvelope(stagedAction) {
    return {
      type: 'AGUI_HITL_SUSPENDED',
      timestamp: new Date().toISOString(),
      actionId: stagedAction.actionId,
      authorizationLevel: stagedAction.authorizationLevel,
      stagedAction,
      promptToUser: 'Authorization required before dispatching external communication.'
    };
  }
}
