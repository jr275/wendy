# WENDY — CAPABILITY MAP & COMPETENCY TAXONOMY
**Document Version:** 1.0.0  
**Target:** Anticipatory Executive Co-Intelligence  

---

## 1. Overview of Capability Pillars

Wendy's capabilities are not isolated utilities (e.g., "email parser", "calendar scraper"). They are unified under five foundational intelligence pillars:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           1. EXECUTIVE AWARENESS                                 │
│         Priorities • Strategic Goals • Cognitive Load • Attention Budget         │
└──────────────┬───────────────────┬───────────────────┬───────────────────┬───────┘
               │                   │                   │                   │
┌──────────────▼─────┐ ┌───────────▼───────┐ ┌─────────▼─────────┐ ┌────────▼────────┐
│    2. CALENDAR     │ │     3. EMAIL      │ │  4. RELATIONSHIP  │ │   5. ACTION &   │
│    INTELLIGENCE    │ │   INTELLIGENCE    │ │   INTELLIGENCE    │ │  AUTHORIZATION  │
│  Briefings • Prep  │ │ Intent • Promises │ │ Dynamics • Trust  │ │ Staging • HITL  │
│ Conflicts • Cadence│ │ Threads • Drafts  │ │  Reciprocity • BD │ │ Verif. • Ledger │
└──────────────┬─────┘ └───────────┬───────┘ └─────────┬─────────┘ └────────┬────────┘
               │                   │                   │                    │
┌──────────────┴───────────────────┴───────────────────┴────────────────────▼──────┐
│                       6. PERSISTENT KNOWLEDGE & MEMORY                           │
│        Episodic Logs • Semantic Graph • Trajectories • Historical Outcomes        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Deep Capability Matrix

### 2.1 Executive Awareness
| Capability | Description | Input Signals | Proactive Output |
| :--- | :--- | :--- | :--- |
| **Priority Alignment** | Understands current quarterly OKRs, active fundraising, or product launches. | Executive direct input, strategy docs, board decks. | Filters out distraction requests; flags misaligned calendar time. |
| **Cognitive Load Modeling** | Monitors meeting density, context switching, and uninterrupted focus time. | Calendar schedule, message velocity. | Recommends buffer blocks; protects deep-work mornings. |
| **Decision Ledger** | Tracks major decisions made in meetings, their rationale, and dependencies. | Meeting transcripts, email approvals, Slack confirmations. | Reminds when pending decisions block team members. |
| **Risk & Blindspot Radar** | Identifies unaddressed risks (e.g., key client gone silent, unfulfilled promises). | Interaction logs, sent proposals, customer emails. | Surfaces early warning signals before emergencies arise. |

### 2.2 Calendar Intelligence
| Capability | Description | Input Signals | Proactive Output |
| :--- | :--- | :--- | :--- |
| **Anticipatory Briefing Packets** | Prepares concise dossiers 30 minutes before every high-stakes meeting. | Meeting subject, attendee profiles, past notes, recent emails. | 3-bullet summary: (1) what they want, (2) what we owe them, (3) key context. |
| **Attendee Intelligence** | Profiling attendees: past encounters, mutual connections, organizational stature. | CRM, LinkedIn, historical meeting notes, company directory. | Identifies hidden influencers and past friction points. |
| **Temporal Buffer & Travel Guardian**| Computes realistic transit, mental recharge, and technical setup time. | Locations, flight schedules, calendar entries. | Warns of physically impossible transitions or tight connections. |
| **Schedule Optimization & Defense**| Spots fragmented 30-min gaps and suggests restructuring. | Weekly schedule view. | Suggests consolidated batch meetings to reclaim uninterrupted half-days. |

### 2.3 Email & Communication Intelligence
| Capability | Description | Input Signals | Proactive Output |
| :--- | :--- | :--- | :--- |
| **Commitment Harvester** | Detects promises made by the executive (*"I'll send the deck by Friday"*) or to the executive (*"I'll review over the weekend"*). | Outgoing and incoming emails, meeting transcripts. | Tracks unfulfilled commitments and alerts before deadlines pass. |
| **Intent & Urgency Classification**| Distinguishes between polite noise and critical executive matters. | Message headers, body text, sender relationship tier. | Suppresses low-urgency notifications; escalates genuine crises. |
| **Persona-Calibrated Drafting** | Generates drafts matching the executive's nuanced voice, brevity, and relationship familiarity. | Past sent emails, relationship closeness, explicit guidance. | High-fidelity draft ready for single-click executive approval. |
| **Thread Archaeology** | Reconstructs fragmented threads across months, consolidating key agreements. | Email threads, attachments, forwarded notes. | Delivers a clean chronology of negotiations and final terms. |

### 2.4 Relationship Intelligence
| Capability | Description | Input Signals | Proactive Output |
| :--- | :--- | :--- | :--- |
| **Cadence & Drift Detection** | Monitors communication frequency with Tier 1 contacts; detects fading relationships. | Email, calendar, messaging history. | *"You haven't spoken with Partner Sarah in 75 days. She recently announced a fund close."* |
| **Reciprocity & Balance Index** | Tracks who owes whom favors, introductions, or work product. | Interaction logs, commitments. | Prevents awkward encounters where the executive is in debt. |
| **Life Milestones & Thoughtfulness**| Tracks birthdays, promotions, company milestones, and personal details. | Conversations, signature changes, public announcements. | Prepares contextual congratulations with historical personal touches. |
| **Stakeholder Influence Mapping** | Models power dynamics and key lieutenants within partner organizations. | Meeting attendee groupings, email cc patterns. | Advises on who to include when pitching or negotiating. |

### 2.5 Action Execution & Governance
| Capability | Description | Input Signals | Proactive Output |
| :--- | :--- | :--- | :--- |
| **Multi-Tier Authorization** | Enforces strict Level 0-4 permission boundaries. | Action intent, impact radius, external side effects. | Renders interactive AG-UI approval cards for Level 3/4 actions. |
| **Idempotent Dispatch** | Executes actions with transactional guarantees and deduplication keys. | Approved action queue. | Dispatches emails, updates calendar without duplicate entries. |
| **Outcome Verification** | Verifies downstream effects of actions (e.g., RSVP confirmed, document received). | Telemetry feeds, incoming receipts. | Confirms resolution to memory and notifies only if failure occurs. |

---

## 3. Maturity Horizons

```
HORIZON 1: THE ACUTE OBSERVER & PREPARER (MVP)
├── Core Event Ingestion (Calendar, Gmail, Contacts)
├── Basic Semantic Graph & Commitment Extraction
├── Anticipatory Briefings (30 min pre-meeting)
├── Relationship Milestone Radar (Birthdays, Anniversaries)
├── AG-UI Agentic Chat + Interactive Approval Cards
└── Verification Loop for Drafts & Approvals

HORIZON 2: THE ACTIVE OPERATIONAL PARTNER
├── Automated Schedule Defragmentation & Focus Defense
├── Multi-Hop Thread Archaeology & Contract Variance Spotting
├── Deep Reciprocity & Relationship Velocity Analytics
├── Multi-Channel Ingestion (Slack, Drive/Docs, CRM)
└── Shared State Bi-Directional Canvas (Editable Briefings)

HORIZON 3: THE AUTONOMOUS STRATEGIC PRESENCE
├── Specialized Multi-Agent Subgraphs (Calendar Agent, Research Agent, Travel Agent)
├── Ambient Voice & Subtle Visual Presence (Restrained Avatar Layer)
├── Continuous Strategic Horizon Scanning (Industry News, M&A, Competitive Moves)
└── Predictive Opportunity Routing
```
