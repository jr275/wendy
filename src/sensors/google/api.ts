/**
 * Gmail and Calendar, READ-ONLY, behind a small interface (tests use a fake). Only GET requests.
 * Mail comes as raw RFC 822 and goes through the same parser as the Takeout importer.
 */
import type { OAuth2Client } from 'google-auth-library';
import type { IcsOccurrence } from '../../importers/ics.js';
import { parseMail, type ParsedMail } from '../../importers/mbox.js';

export interface GoogleApi {
  /** Message ids newer than `after` (Gmail excludes spam and trash by default). */
  listMessageIds(after: Date): Promise<string[]>;
  getMessage(id: string): Promise<ParsedMail | null>;
  listEvents(from: Date, to: Date): Promise<IcsOccurrence[]>;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
/** Gmail system labels → names the importer's exclusion rules know. */
const LABEL_NAMES: Record<string, string> = { SPAM: 'spam', TRASH: 'trash', CHAT: 'chat' };

interface GEvent {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

export function eventToOccurrence(e: GEvent): IcsOccurrence | null {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  const start = e.start?.dateTime ?? e.start?.date;
  const end = e.end?.dateTime ?? e.end?.date ?? start;
  if (!start || !end) return null;
  return {
    uid: e.iCalUID ?? e.id,
    externalId: e.id, // instance id: unique per occurrence of a recurring event
    title: e.summary ?? '(sem título)',
    description: e.description ?? '',
    startsAt: new Date(start),
    endsAt: new Date(end),
    allDay,
    status: e.status === 'cancelled' ? 'CANCELLED' : e.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
    organizer: e.organizer?.email?.toLowerCase() ?? null,
    attendees: (e.attendees ?? []).filter((a) => a.email).map((a) => ({ address: a.email!.toLowerCase(), name: a.displayName ?? null, partstat: a.responseStatus ?? null })),
  };
}

export class GoogleRestApi implements GoogleApi {
  constructor(private readonly client: OAuth2Client) {}

  private async get<T>(url: string): Promise<T> {
    const r = await this.client.request<T>({ url, method: 'GET', retry: true });
    return r.data;
  }

  async listMessageIds(after: Date): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    const q = `after:${Math.floor(after.getTime() / 1000)}`;
    do {
      const u = new URL(`${GMAIL}/messages`);
      u.searchParams.set('q', q);
      u.searchParams.set('maxResults', '500');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>(u.toString());
      ids.push(...(r.messages ?? []).map((m) => m.id));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return ids;
  }

  async getMessage(id: string): Promise<ParsedMail | null> {
    const r = await this.get<{ id: string; threadId: string; labelIds?: string[]; raw?: string }>(`${GMAIL}/messages/${id}?format=raw`);
    if (!r.raw) return null;
    const m = parseMail(Buffer.from(r.raw, 'base64url').toString('latin1'));
    return { ...m, messageId: m.messageId ?? `gmail:${r.id}`, threadId: r.threadId, labels: (r.labelIds ?? []).map((l) => LABEL_NAMES[l] ?? l.toLowerCase()) };
  }

  async listEvents(from: Date, to: Date): Promise<IcsOccurrence[]> {
    const out: IcsOccurrence[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(CAL);
      u.searchParams.set('timeMin', from.toISOString());
      u.searchParams.set('timeMax', to.toISOString());
      u.searchParams.set('singleEvents', 'true');
      u.searchParams.set('showDeleted', 'true');
      u.searchParams.set('maxResults', '2500');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await this.get<{ items?: GEvent[]; nextPageToken?: string }>(u.toString());
      for (const e of r.items ?? []) {
        const o = eventToOccurrence(e);
        if (o) out.push(o);
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
}
