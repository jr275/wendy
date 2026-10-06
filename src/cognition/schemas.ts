import { z } from 'zod';

/** Step 1 — semantic understanding of a source text. Every extracted signal must quote the source. */
export const UnderstandingSchema = z.object({
  summary: z.string().describe('One or two sentences: what the text says, without interpretation.'),
  language: z.string().describe('BCP-47 language of the text, e.g. "en" or "pt-BR".'),
  mentioned_people: z
    .array(
      z.object({
        name: z.string().nullable().describe('Name exactly as written, or null.'),
        email: z.string().nullable().describe('Email address if present in the text, else null.'),
        role: z.string().describe('Role in the text, e.g. sender, addressee, mentioned.'),
      }),
    )
    .describe('People referred to in the text (excluding generic pronouns).'),
  topics: z
    .array(
      z.object({
        label: z.string().describe('Short topic label.'),
        search_terms: z
          .array(z.string())
          .describe('1–2 word search terms for finding related records: synonyms, singular/plural and inflected variants, and translations (English and Portuguese).'),
      }),
    )
    .describe('Subjects the text is about.'),
  requests: z.array(z.object({ description: z.string(), quote: z.string().describe('Verbatim excerpt from the text.') })),
  time_references: z
    .array(
      z.object({
        description: z.string(),
        quote: z.string().describe('Verbatim excerpt from the text.'),
        resolved_iso: z
          .string()
          .nullable()
          .describe('ISO-8601 date or datetime this refers to, resolved against the text timestamp, or null if it cannot be resolved.'),
      }),
    )
    .describe('Deadlines, dates, and references to scheduled events (e.g. "before tomorrow\'s meeting").'),
  urgency_signals: z
    .array(z.object({ quote: z.string().describe('Verbatim excerpt from the text.'), strength: z.number().describe('0 to 1.') }))
    .describe('Explicit expressions of urgency or time pressure. Empty if none.'),
});
export type Understanding = z.infer<typeof UnderstandingSchema>;

const ClaimSchema = z.object({
  id: z.string().describe('C1, C2, ... unique within this response.'),
  kind: z.enum(['INFERENCE', 'HYPOTHESIS', 'ANTICIPATION', 'RECOMMENDATION']),
  statement: z.string(),
  confidence: z.number().describe('0 to 1.'),
  evidence: z.array(z.string()).describe('Evidence handles (e.g. M2, MT1) that directly support this claim.'),
  derived_from: z.array(z.string()).describe('Ids of earlier claims this one builds on.'),
  about_people: z.array(z.string()).describe('Person handles (P#) this claim is about.'),
});

const BriefingSchema = z.object({
  title: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      points: z.array(z.object({ text: z.string(), claims: z.array(z.string()), evidence: z.array(z.string()) })),
    }),
  ),
});

/** Step 2 — reasoning over the retrieved evidence. */
export const ReasoningSchema = z.object({
  relevant_evidence: z.array(z.string()).describe('Handles of the evidence items that actually matter for this event.'),
  claims: z.array(ClaimSchema),
  headline: z.string().describe("One line for the principal, in the principal's language."),
  narrative: z
    .string()
    .describe("Short message to the principal in their language. Every sentence that asserts something must cite claim ids in brackets, e.g. [C2]."),
  assessment: z.object({
    urgency: z
      .object({ value: z.number(), rationale: z.string(), quotes: z.array(z.string()).describe('Verbatim excerpts from the event source text.') })
      .nullable()
      .describe('Null when the event has no source text (e.g. detector events).'),
    business_impact: z.object({ value: z.number(), rationale: z.string(), evidence: z.array(z.string()) }),
    applicable_preferences: z.array(z.object({ memory: z.string().describe('Memory handle (MEM#).'), effect: z.enum(['RAISE', 'LOWER']) })),
  }),
  conflicts: z.array(z.object({ description: z.string(), evidence: z.array(z.string()) })).describe('Evidence items that contradict each other.'),
  information_gaps: z.array(z.string()).describe('What Wendy does not know that would change the reading.'),
  completion_assessment: z
    .object({ status: z.enum(['NOT_APPLICABLE', 'NO_EVIDENCE_OF_COMPLETION', 'POSSIBLY_DONE', 'DONE']), evidence: z.array(z.string()) })
    .describe('For commitments: is there evidence it was fulfilled? NOT_APPLICABLE otherwise.'),
  proposed_actions: z.array(
    z.object({
      type: z.enum(['PREPARE_BRIEFING', 'SEND_EMAIL']),
      target_person: z.string().nullable().describe('Person handle.'),
      related_meeting: z.string().nullable().describe('Meeting handle, if the action prepares for a meeting.'),
      justification_claims: z.array(z.string()),
      briefing: BriefingSchema.nullable(),
      email: z.object({ to_person: z.string(), subject: z.string(), body: z.string() }).nullable(),
    }),
  ),
  memory_proposals: z
    .array(
      z.object({
        kind: z.enum(['PREFERENCE', 'FACT']),
        about_person: z.string().nullable(),
        content: z.string(),
        evidence: z.array(z.string()),
        confidence: z.number(),
      }),
    )
    .describe('Durable facts or preferences worth remembering, each grounded in evidence. Empty if none.'),
});
export type Reasoning = z.infer<typeof ReasoningSchema>;

/** Answering a direct question from the principal. */
export const AnswerSchema = z.object({
  answer: z.string().describe("Answer in the principal's language. Cite claim ids in brackets."),
  claims: z.array(ClaimSchema),
  used_evidence: z.array(z.string()),
  conflicts: z.array(z.object({ description: z.string(), evidence: z.array(z.string()) })),
  information_gaps: z.array(z.string()),
});
export type Answer = z.infer<typeof AnswerSchema>;
