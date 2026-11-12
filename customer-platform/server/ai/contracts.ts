/** A provider receives message context only and returns untrusted candidate fields.
 * It has no ledger, account, session or write capability. A future Claude transport
 * can implement this interface without changing the server validation boundary. */
export type AiContext = {message: string; startDate: string; endDate: string; timeZone: string; now: string};
export interface AiProvider {
  readonly source: 'synthetic' | 'claude';
  extract(context: AiContext): Promise<unknown>;
}
