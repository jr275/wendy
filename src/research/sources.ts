/**
 * The specialised sources the daily reading digest looks at (machine learning, AI, science). Public RSS/Atom feeds only; nothing here needs an
 * account or a key. Verified reachable on 2026-10-16 (a plain GET returned 200 and parseable items). The Science (AAAS) feed answered 403 and is
 * NOT listed. A source can be removed or added by editing this list: it is the ONLY place a feed address comes from (never a model, never a message).
 */
export type SourceKind = 'paper' | 'news' | 'blog';

export interface FeedSource {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  /** 0–3: how much the source itself counts toward the ranking. Papers are a firehose, so each one counts for little. */
  weight: number;
}

export const FEED_SOURCES: readonly FeedSource[] = [
  { id: 'arxiv-lg', name: 'arXiv · Machine Learning', url: 'https://rss.arxiv.org/rss/cs.LG', kind: 'paper', weight: 0.5 },
  { id: 'arxiv-ai', name: 'arXiv · Inteligência Artificial', url: 'https://rss.arxiv.org/rss/cs.AI', kind: 'paper', weight: 0.5 },
  { id: 'deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', kind: 'blog', weight: 3 },
  { id: 'google-ai', name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', kind: 'blog', weight: 2 },
  { id: 'openai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml', kind: 'blog', weight: 2.5 },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', kind: 'blog', weight: 2.5 },
  { id: 'bair', name: 'Berkeley AI Research', url: 'https://bair.berkeley.edu/blog/feed.xml', kind: 'blog', weight: 2.5 },
  { id: 'gradient', name: 'The Gradient', url: 'https://thegradient.pub/rss/', kind: 'blog', weight: 2 },
  { id: 'import-ai', name: 'Import AI', url: 'https://importai.substack.com/feed', kind: 'blog', weight: 2 },
  { id: 'raschka', name: 'Ahead of AI (Sebastian Raschka)', url: 'https://magazine.sebastianraschka.com/feed', kind: 'blog', weight: 2 },
  { id: 'lilian-weng', name: 'Lil\'Log (Lilian Weng)', url: 'https://lilianweng.github.io/index.xml', kind: 'blog', weight: 2.5 },
  { id: 'quanta', name: 'Quanta Magazine', url: 'https://www.quantamagazine.org/feed/', kind: 'news', weight: 1.5 },
  { id: 'mit-tr', name: 'MIT Technology Review · IA', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', kind: 'news', weight: 1.5 },
];

/** The only hosts a feed may be fetched from (and redirected to). Derived from the list above. */
export const ALLOWED_FEED_HOSTS: ReadonlySet<string> = new Set(FEED_SOURCES.map((s) => new URL(s.url).hostname));

export const TOPICS: readonly { label: string; re: RegExp; weight: number }[] = [
  { label: 'transformers e atenção', re: /\b(transformers?|attention|state[- ]space|mamba|long[- ]context)\b/i, weight: 1 },
  { label: 'escala e eficiência', re: /\b(scaling laws?|mixture[- ]of[- ]experts|moe|distillation|quantization|pruning|inference|efficien(?:t|cy))\b/i, weight: 1 },
  { label: 'aprendizado por reforço', re: /\b(reinforcement learning|rlhf|rlvr|policy gradient|reward model|bandits?)\b/i, weight: 1 },
  { label: 'raciocínio e agentes', re: /\b(reasoning|agents?|agentic|tool use|chain[- ]of[- ]thought|planning)\b/i, weight: 1 },
  { label: 'avaliação e robustez', re: /\b(benchmarks?|evaluation|calibration|out[- ]of[- ]distribution|distribution shift|robustness|hallucinations?)\b/i, weight: 1 },
  { label: 'causalidade e inferência', re: /\b(causal(?:ity)?|bayesian|uncertainty|conformal|identifiab)/i, weight: 1 },
  { label: 'representações', re: /\b(embeddings?|representation learning|contrastive|self[- ]supervised)\b/i, weight: 1 },
  { label: 'modelos generativos', re: /\b(diffusion|flow matching|generative|autoregressive)\b/i, weight: 0.75 },
  { label: 'interpretabilidade e segurança', re: /\b(interpretab|mechanistic|alignment|safety|red[- ]team)/i, weight: 1 },
  { label: 'produção e MLOps', re: /\b(deployment|latency|serving|data leakage|mlops|distributed training)\b/i, weight: 0.75 },
  { label: 'otimização', re: /\b(optimi[sz](?:er|ation)|convex|adam|gradient descent|loss landscape|generalization)\b/i, weight: 0.75 },
];
