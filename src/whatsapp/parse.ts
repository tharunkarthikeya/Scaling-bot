/**
 * Normalises Meta's webhook envelope into a flat list of things we care about.
 * The wire format nests four levels deep and mixes messages with delivery
 * statuses; everything downstream works off these two types instead.
 */

export interface InboundMessage {
  wamid: string;
  waId: string;
  phone: string;
  profileName?: string;
  timestamp: Date;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'interactive' | 'other';
  text?: string;
  /**
   * The option id carried by a tapped button or list row.
   *
   * This is the id we set when we sent the message, so it identifies the answer
   * exactly — no language, spelling or interpretation is involved. A tap is the
   * one input the bot never has to work out the meaning of.
   */
  replyId?: string;
  media?: {
    id: string;
    mimeType: string;
    filename?: string;
    caption?: string;
    sha256?: string;
  };
  /** Present when the candidate replied to a specific earlier message. */
  contextWamid?: string;
  /**
   * Which of the agency's numbers this arrived on, as Meta identifies it.
   *
   * The business has more than one, and they do not run the same flow — see
   * `conversation/lines.ts`. It is read off the envelope rather than inferred,
   * because it is the only thing in the payload that says which number the
   * candidate actually wrote to.
   */
  phoneNumberId?: string;
}

export interface InboundStatus {
  wamid: string;
  waId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  errorTitle?: string;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: InboundStatus[];
}

type AnyRecord = Record<string, any>;

const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);

export function parseWebhook(body: unknown): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  const payload = body as AnyRecord;

  if (payload?.object !== 'whatsapp_business_account') return out;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value as AnyRecord;

      // Present on every real delivery; absent only from a hand-rolled payload.
      // `sendingNumberFor` treats absence as the main number, so a missing one
      // costs nothing.
      const phoneNumberId = value.metadata?.phone_number_id
        ? String(value.metadata.phone_number_id)
        : undefined;

      const contacts = new Map<string, { name?: string }>();
      for (const contact of value.contacts ?? []) {
        contacts.set(contact.wa_id, { name: contact.profile?.name });
      }

      for (const msg of value.messages ?? []) {
        const waId = String(msg.from);
        const parsed: InboundMessage = {
          wamid: String(msg.id),
          waId,
          phone: waId,
          profileName: contacts.get(waId)?.name,
          timestamp: new Date(Number(msg.timestamp) * 1000),
          type: 'other',
          contextWamid: msg.context?.id,
          phoneNumberId,
        };

        if (msg.type === 'text') {
          parsed.type = 'text';
          parsed.text = msg.text?.body ?? '';
        } else if (msg.type === 'interactive') {
          parsed.type = 'interactive';
          const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
          // The id is what the flow acts on; the title is kept for the transcript
          // so a human reading it sees what the candidate saw.
          parsed.replyId = reply?.id ? String(reply.id) : undefined;
          parsed.text = reply?.title ?? '';
        } else if (msg.type === 'button') {
          // A quick reply on a template. The payload is what we set when the
          // template was created; the text is what the candidate saw.
          parsed.type = 'interactive';
          parsed.replyId = msg.button?.payload ? String(msg.button.payload) : undefined;
          parsed.text = msg.button?.text ?? '';
        } else if (MEDIA_TYPES.has(msg.type)) {
          const media = msg[msg.type] as AnyRecord;
          parsed.type = msg.type === 'sticker' ? 'other' : msg.type;
          parsed.media = {
            id: String(media.id),
            mimeType: String(media.mime_type ?? 'application/octet-stream'),
            filename: media.filename,
            caption: media.caption,
            sha256: media.sha256,
          };
          parsed.text = media.caption ?? undefined;
        }

        out.messages.push(parsed);
      }

      for (const status of value.statuses ?? []) {
        out.statuses.push({
          wamid: String(status.id),
          waId: String(status.recipient_id),
          status: status.status,
          timestamp: new Date(Number(status.timestamp) * 1000),
          errorTitle: status.errors?.[0]?.title,
        });
      }
    }
  }

  return out;
}
