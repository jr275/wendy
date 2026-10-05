# WENDY — EXECUTIVE UX SYSTEM & INTERACTION SPECIFICATION
**Standard:** Elite Executive Workspace  
**Aesthetic:** Restrained, Editorial, Cinematic, High-Information-Density, Quiet  
**Protocol:** AG-UI (Agent-User Interaction Protocol)  

---

## 1. Visual & Spatial Philosophy

Wendy's interface is not a SaaS dashboard, a CRM, an admin console, or a generic chat assistant. It is a high-density, calm, and intellectually respectful workspace that feels like stepping into an elite private executive suite.

### Core Aesthetic Pillars
- **Quiet Authority:** No neon accents, no decorative gradients, no floating glassmorphic blurs, and no frivolous "AI sparkle" icons. 
- **Editorial Typography:** High-contrast serif headlines paired with razor-sharp geometric sans-serif metadata. Elegant vertical rhythms and deliberate typographic scale.
- **Monochrome Foundation with Intentional Color:** A palette of warm stone, deep slate, off-white, and muted charcoal. Color is reserved exclusively for functional semantics:
  - *Muted Amber:* Level 3/4 Approval Required
  - *Deep Forest Olive:* Verified Outcome
  - *Oxblood/Crimson:* Overdue Commitment / Strategic Risk
  - *Cadet Slate:* Context & Provenance Reference
- **Presence, Not Theatrics:** Wendy’s presence indicator is subtle (e.g., a serene, micro-breathing horizon or discreet status thread: *"Synthesizing afternoon schedule"*), never an exaggerated bouncing character.

---

## 2. Spatial Layout & Information Architecture

The viewport is arranged into three harmonized zones designed for zero-clutter focus:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ W E N D Y   │   M O N D A Y ,   O C T O B E R   5   │   P R I V A T E   E X E C U T I V E   │
├─────────────────────────┬──────────────────────────────────┬───────────────────────────┤
│                         │                                  │                           │
│   ZONE A: THE DOSSIER   │     ZONE B: THE ACTIVE THREAD    │   ZONE C: ACTION STAGING  │
│                         │                                  │                           │
│ • What Matters Now      │ • AG-UI Agentic Conversation     │ • Prepared Action Cards   │
│   - Carlos Mtg (14:00)  │ • Streaming Thought Trajectory   │ • Email Draft to Carlos   │
│   - Mariana's Birthday  │ • Natural Language Dialogue      │ • Birthday Note to Mariana│
│   - Proposal Commitment │ • Live Contextual Drill-Down     │                           │
│                         │                                  │ [One-Click Authorization] │
│ • Can Wait (Suppressed) │ • Provenance Footnotes           │ [Inline Modification]     │
│   - Non-critical sync   │   [Fact] [Inference] [Source]    │                           │
│                         │                                  │ [Verified Audit State]    │
│ • Relationship Radar    │                                  │                           │
│                         │                                  │                           │
└─────────────────────────┴──────────────────────────────────┴───────────────────────────┘
```

### Zone A: The Strategic Dossier ("What Wendy Has Seen")
- Automatically opens on session launch.
- Displays the **Salience Quadrant**:
  1. **Urgent & Immediate:** Meetings within 4 hours and active risks.
  2. **Relationship Milestones:** Personal anniversaries, birthdays, reciprocity debt.
  3. **Open Commitments:** Promises made to or by the executive.
  4. **"Can Wait" Archive:** Proactively informs the executive of low-priority noise that Wendy has deliberately suppressed.

### Zone B: The Active Thread (AG-UI Agentic Conversation)
- Conversational stream powered by the **AG-UI Protocol**.
- Streams natural dialogue alongside **Tool Rendering Cards**:
  - Instead of technical debug logs, Wendy streams dignified progress notes:
    > *"Reviewing correspondence with Carlos over the last 90 days and indexing the latest pricing deck..."*
- Interactive inline components (e.g., collapsible timeline, attendee dossiers).

### Zone C: The Action Staging Drawer
- Houses Level 3 and Level 4 proposals awaiting executive authorization.
- Provides immediate inline editing of drafted emails or calendar shifts.
- Distinct visual badges for **Approval Levels**:
  - `[ LEVEL 3 — EXTERNAL COMMUNICATION ]`
  - `[ REVERSIBILITY: IRREVERSIBLE ON SEND ]`
- Explicit confirmation controls: `[ Approve & Dispatch ]`, `[ Edit Draft ]`, `[ Snooze to 12:00 ]`.

---

## 3. The AG-UI Interaction Protocol Implementation

Wendy implements the core patterns demonstrated in the AG-UI specification:

### 3.1 Streaming Agentic Reasoning
- Inferences stream progressively into the chat interface.
- Reasoning is categorized into collapsible **Provenance Traces**:
  - Clicking a badge reveals: *"Observed in email from Carlos at 08:14. Confidence: 96%."*

### 3.2 Human-in-the-Loop (HITL) Interrupts
- When Wendy stages an action (e.g. sending a personal email to Mariana), execution halts cleanly at the AG-UI boundary.
- The UI renders an interactive **A2UI Action Envelope**:
  ```tsx
  <ActionCard
    title="Send Birthday Greeting to Mariana"
    level={3}
    provenance={["Birthday tomorrow", "Tier 1 Relationship", "Sent note last year"]}
    preview={<EmailDraft recipient="Mariana Vance" subject="Thinking of you" body="..." />}
    onApprove={() => resumeExecution({ status: 'APPROVED' })}
    onModify={(newText) => resumeExecution({ status: 'APPROVED_WITH_MODS', payload: newText })}
    onReject={() => resumeExecution({ status: 'REJECTED' })}
  />
  ```

### 3.3 Two-Way Shared State Synchronization
- If the executive tweaks the draft text directly in Zone C, the updated text is immediately synchronized back into Wendy's agentic context via AG-UI state sync.
- Wendy does not need to restart her reasoning cycle; she instantly adapts to the executive’s edits.

---

## 4. Voice, Tone & Conversational Rules

1. **Precision of Address:**
   - Wendy speaks with the natural conciseness of a world-class Chief of Staff.
   - Example opening:
     > *"Good morning. I’ve reviewed the overnight correspondence and your afternoon schedule. Three items require your attention, and I have prepared the two necessary actions."*
2. **Never Theatrical:**
   - Forbidden phrases: *"I am an AI", "As a language model", "I'd love to help you with that", "Sure thing!", "Great question!"*
3. **Disagreement with Evidence:**
   - When the executive suggests an action with hidden friction:
     > *"You asked me to move the strategy session to 16:00. Note that this immediately abuts your flight to New York, leaving zero margin for airport transit. I recommend Thursday morning instead."*
