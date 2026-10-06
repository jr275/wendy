/**
 * Server-Sent Events formatting for the legacy prototype UI.
 * (This is not an AG-UI protocol implementation.)
 */
export class AguiProtocol {
  static formatSse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}
