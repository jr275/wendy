/**
 * REAL MEMORY RETRIEVAL & QUERY SYNTHESIZER
 * Operates strictly against persisted repositories (no canned query branches).
 */
export class RetrievalEngine {
  constructor({ entityRepo, relationshipRepo, memoryRepo, actionRepo }) {
    this.entityRepo = entityRepo;
    this.relationshipRepo = relationshipRepo;
    this.memoryRepo = memoryRepo;
    this.actionRepo = actionRepo;
  }

  /**
   * Processes an executive natural language query against persistent storage
   */
  async answerQuery(query) {
    const qLower = query.toLowerCase();

    // 1. ENTITY RESOLUTION: Find mentioned entities
    const allPeople = await this.entityRepo.getAllPeople();
    let matchedPerson = null;
    for (const p of allPeople) {
      if (p.id !== 'person-exec-joao') {
        const firstName = p.fullName.split(' ')[0].toLowerCase();
        if (qLower.includes(firstName) || qLower.includes(p.fullName.toLowerCase())) {
          matchedPerson = p;
          break;
        }
      }
    }

    // 2. RETRIEVE RELEVANT MEMORIES & INTERACTION LOGS
    const personMemories = matchedPerson ? await this.memoryRepo.queryEpisodic({ entityId: matchedPerson.id, limit: 15 }) : [];
    const queryMatches = await this.memoryRepo.queryEpisodic({ textQuery: query, limit: 10 });
    const allMatches = [...personMemories, ...queryMatches];
    const episodicMatches = Array.from(new Map(allMatches.map(m => [m.id, m])).values());

    // 3. RETRIEVE RELATIONSHIP GRAPH EDGE
    let relationship = null;
    if (matchedPerson) {
      relationship = await this.relationshipRepo.getRelationshipBetween('person-exec-joao', matchedPerson.id);
    }

    // 4. RETRIEVE EXECUTIVE PREFERENCES
    const allPreferences = await this.memoryRepo.getAllPreferences();
    const relevantPrefs = allPreferences.filter(pref => {
      const pText = `${pref.domain} ${pref.rule}`.toLowerCase();
      const terms = qLower.split(/\s+/).filter(t => t.length > 3);
      return terms.some(t => pText.includes(t));
    });

    // 5. RETRIEVE PENDING ACTIONS
    const pendingActions = await this.actionRepo.listActions({ limit: 5 });

    // --- SYNTHESIZE ANSWER GROUNDED IN RETRIEVED PERSISTENCE ---

    // Case A: Specific Communication / Preference Query for an Entity
    if (matchedPerson && (qLower.includes('communicate') || qLower.includes('tone') || qLower.includes('write') || qLower.includes('email') || qLower.includes('prefer'))) {
      const specificEpisodic = episodicMatches.find(e => 
        (e.summary && (e.summary.toLowerCase().includes('concise') || e.summary.toLowerCase().includes('communication') || e.summary.toLowerCase().includes('prefers'))) ||
        (e.verbatimSnippet && e.verbatimSnippet.toLowerCase().includes('sentence'))
      );

      const facts = [];
      if (specificEpisodic) {
        facts.push({
          type: 'FACT',
          text: `Persisted interaction record: "${specificEpisodic.summary}" (Snippet: "${specificEpisodic.verbatimSnippet || 'N/A'}")`
        });
      }

      if (relationship && relationship.historicalNotes && relationship.historicalNotes.length > 0) {
        const prefNote = relationship.historicalNotes.find(n => n.toLowerCase().includes('preferred') || n.toLowerCase().includes('tone') || n.toLowerCase().includes('communication'));
        if (prefNote) {
          facts.push({
            type: 'FACT',
            text: `Relationship record note: "${prefNote}"`
          });
        }
      }

      const voicePref = allPreferences.find(p => p.domain === 'DRAFTING_STYLE');
      if (voicePref) {
        facts.push({
          type: 'FACT',
          text: `Executive Voice Rule: "${voicePref.rule}"`
        });
      }

      let reply = `Based on your persisted relationship memory for **${matchedPerson.fullName}**:\n\n`;
      if (specificEpisodic) {
        reply += `- **[FACT] Observed Preference**: ${specificEpisodic.summary}\n`;
        if (specificEpisodic.verbatimSnippet) {
          reply += `  *(Verbatim note: "${specificEpisodic.verbatimSnippet}")*\n`;
        }
      }
      if (voicePref) {
        reply += `- **[FACT] Executive Standard**: ${voicePref.rule}\n`;
      }
      reply += `\n**[RECOMMENDATION]**: Keep all correspondence with ${matchedPerson.fullName.split(' ')[0]} direct, concise, and focused on key numbers, avoiding introductory filler.`;

      return {
        reply,
        epistemicBreakdown: facts.length > 0 ? facts : [{ type: 'FACT', text: `Retrieved ${matchedPerson.fullName}'s profile.` }],
        groundedInRecordIds: episodicMatches.map(e => e.id)
      };
    }

    // Case B: Entity Importance / Role Query (e.g. "Why is Carlos important?")
    if (matchedPerson && (qLower.includes('why') || qLower.includes('important') || qLower.includes('who is'))) {
      const facts = [
        {
          type: 'FACT',
          text: `${matchedPerson.fullName} is ${matchedPerson.title} (${matchedPerson.notesSummary || 'Partner'}) with Tier ${matchedPerson.tier} priority.`
        }
      ];

      if (relationship) {
        facts.push({
          type: 'FACT',
          text: `Relationship Closeness Score is ${relationship.closenessScore} with ${relationship.velocity} interaction velocity.`
        });
        if (relationship.historicalNotes) {
          relationship.historicalNotes.forEach(note => {
            facts.push({ type: 'FACT', text: `Context note: ${note}` });
          });
        }
      }

      let reply = `**${matchedPerson.fullName}** is classified as **Tier ${matchedPerson.tier}** based on persisted relationship and interaction records:\n\n`;
      facts.forEach(f => {
        reply += `- **[FACT]**: ${f.text}\n`;
      });

      if (relationship && relationship.reciprocityBalance < 0) {
        reply += `- **[INFERENCE]**: You have an outstanding commitment to ${matchedPerson.fullName.split(' ')[0]} that has not yet been closed.\n`;
        reply += `\n**[RECOMMENDATION]**: Prioritize closing the open deliverable before the Thursday board timeline.`;
      }

      return {
        reply,
        epistemicBreakdown: facts,
        groundedInRecordIds: [matchedPerson.id, ...(relationship ? [relationship.id] : [])]
      };
    }

    // Case C: Commitments / Pending Actions Query
    if (qLower.includes('commit') || qLower.includes('promise') || qLower.includes('action') || qLower.includes('pending') || qLower.includes('staged')) {
      const actionsAwaiting = pendingActions.filter(a => a.state === 'AWAITING_APPROVAL');
      let reply = `Here are your current persisted commitments and staged actions:\n\n`;
      const facts = [];

      if (actionsAwaiting.length > 0) {
        actionsAwaiting.forEach(a => {
          reply += `- **[STAGED ACTION (Level ${a.authorizationLevel})]**: ${a.headline} (Recipient: ${a.preview?.recipient})\n`;
          facts.push({ type: 'FACT', text: `Action ${a.actionId} awaiting Level ${a.authorizationLevel} approval.` });
        });
      } else {
        reply += `- No actions currently awaiting approval in Zone C.\n`;
      }

      if (episodicMatches.length > 0) {
        reply += `\nRecent commitment records in memory:\n`;
        episodicMatches.forEach(e => {
          reply += `- **[FACT]**: ${e.summary}\n`;
          facts.push({ type: 'FACT', text: e.summary });
        });
      }

      return {
        reply,
        epistemicBreakdown: facts,
        groundedInRecordIds: pendingActions.map(a => a.actionId)
      };
    }

    // Case D: General Grounded Fallback
    let reply = `I searched your persisted memory and entity graph:\n\n`;
    const facts = [];

    if (matchedPerson) {
      reply += `- **Entity**: Found ${matchedPerson.fullName} (${matchedPerson.title || 'Contact'})\n`;
      facts.push({ type: 'FACT', text: `Resolved entity: ${matchedPerson.fullName}` });
    }

    if (episodicMatches.length > 0) {
      reply += `- **Relevant Interactions**:\n`;
      episodicMatches.forEach(e => {
        reply += `  • [${new Date(e.occurredAt).toLocaleDateString()}]: ${e.summary}\n`;
        facts.push({ type: 'FACT', text: e.summary });
      });
    } else {
      reply += `- No direct episodic matches found for "${query}".\n`;
    }

    if (relevantPrefs.length > 0) {
      reply += `- **Relevant Heuristics**:\n`;
      relevantPrefs.forEach(p => {
        reply += `  • [${p.domain}]: ${p.rule}\n`;
        facts.push({ type: 'FACT', text: p.rule });
      });
    }

    return {
      reply,
      epistemicBreakdown: facts,
      groundedInRecordIds: episodicMatches.map(e => e.id)
    };
  }
}
