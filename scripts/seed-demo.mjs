// Seed a demo vault with realistic English notes for screenshots / product shots.
//
// Usage:
//   node scripts/seed-demo.mjs [targetDir]
//
// Defaults to ~/Desktop/wikinest-demo. Writes Markdown files with the same
// frontmatter shape the app itself produces (title / categories / savedAt),
// so the list, article view and category sidebar all look full and natural.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

const targetDir =
  process.argv[2] || path.join(os.homedir(), 'Desktop', 'wikinest-demo');

// ISO timestamp helper spread across the last ~3 months.
const at = (m, d, h = 9, min = 12) =>
  new Date(Date.UTC(2026, m - 1, d, h, min, 0)).toISOString();

const notes = [
  // ---------- AI & LLMs ----------
  {
    slug: 'retrieval-augmented-generation-in-practice',
    title: 'Retrieval-Augmented Generation in Practice',
    categories: ['AI & LLMs', 'Engineering'],
    date: at(7, 14, 10, 5),
    body: `Retrieval-Augmented Generation (RAG) grounds a language model in your own
documents so answers cite real sources instead of hallucinating. The pattern is
simple to describe and surprisingly deep to get right.

## The core loop

\`\`\`mermaid
flowchart LR
  Q[User question] --> E[Embed query]
  E --> S[Vector search]
  S --> C[Top-k chunks]
  C --> P[Prompt + context]
  P --> M[LLM]
  M --> A[Answer + citations]
\`\`\`

## What actually moves the needle

- **Chunking**: smaller, semantically coherent chunks beat giant blobs.
- **Hybrid search**: combine keyword (BM25) with vector similarity.
- **Reranking**: a cross-encoder over the top 20 candidates lifts precision a lot.
- **Citations**: always return the source path so users can verify.

> Retrieval quality caps answer quality. If the right chunk never makes it into
> the context window, no amount of prompting will save you.`,
  },
  {
    slug: 'why-local-first-ai-matters',
    title: 'Why Local-First AI Matters',
    categories: ['AI & LLMs'],
    date: at(6, 28, 8, 40),
    body: `Local-first means your data lives on your machine first, and the network is an
enhancement — not a requirement. For a knowledge base full of half-formed ideas,
that distinction is everything.

## The case for keeping data close

1. **Privacy** — rough notes, client details and unfinished thoughts never leave your disk.
2. **Longevity** — plain Markdown outlives any single app or vendor.
3. **Speed** — search and open are instant; no round trips.
4. **Ownership** — you can grep it, back it up, or move it anywhere.

Cloud sync is still useful. The point isn't to reject the network — it's to make
sure nothing breaks when it's gone.`,
  },
  {
    slug: 'prompt-patterns-that-work',
    title: 'Prompt Patterns That Actually Work',
    categories: ['AI & LLMs'],
    date: at(5, 22, 14, 18),
    body: `Most "prompt engineering" is just clear communication with an eager, literal
assistant. A few patterns show up again and again.

## Patterns

- **Role + task + constraints**: "You are a copy editor. Tighten this. Keep it under 120 words."
- **Few-shot**: show 2–3 examples of the input/output shape you want.
- **Chain-of-thought on demand**: ask it to reason step by step for hard problems only.
- **Structured output**: request JSON with an explicit schema when you'll parse it.

## Anti-patterns

- Vague asks ("make it better") with no criteria.
- Cramming ten instructions into one paragraph.
- Forgetting to say what *not* to do.`,
  },
  {
    slug: 'understanding-model-context-protocol',
    title: 'Understanding the Model Context Protocol (MCP)',
    categories: ['AI & LLMs', 'Engineering'],
    date: at(7, 2, 11, 30),
    body: `MCP is an open protocol that lets AI clients (like Cursor or Claude) talk to
external tools and data sources through a standard interface. Think of it as
"USB for AI context."

## Why it matters

Instead of every app inventing its own integration, a tool exposes a small set
of capabilities and any MCP-aware client can use them:

- **Resources** — readable data (files, notes, records).
- **Tools** — actions the model can invoke.
- **Prompts** — reusable prompt templates.

## In this knowledge base

Wikinest exposes your notes over MCP, so an assistant can search and read your
wiki while it helps you — without copy-pasting anything.`,
  },
  {
    slug: 'embeddings-a-mental-model',
    title: 'Embeddings: A Mental Model',
    categories: ['AI & LLMs'],
    date: at(5, 9, 16, 0),
    body: `An embedding turns a piece of text into a list of numbers such that similar
meanings land near each other in space. That's the whole trick behind semantic
search and RAG.

## Intuition

- Words, sentences, or whole documents become points in a high-dimensional space.
- "Distance" between points approximates "difference in meaning."
- Search becomes geometry: find the nearest neighbors to your query.

## Practical notes

- Normalize vectors and use cosine similarity for most cases.
- Keep the same model for indexing and querying — mixing models breaks distances.
- Re-embed when you change models; old vectors won't be comparable.`,
  },
  {
    slug: 'evaluating-llm-outputs',
    title: 'Evaluating LLM Outputs Without Losing Your Mind',
    categories: ['AI & LLMs', 'Product'],
    date: at(6, 12, 9, 45),
    body: `Shipping an LLM feature without evaluation is flying blind. But you don't need a
research lab — a lightweight eval harness catches most regressions.

## A practical ladder

1. **Golden set** — 20–50 real inputs with known-good outputs.
2. **Assertions** — cheap checks: format valid? contains citation? within length?
3. **LLM-as-judge** — a rubric-scored model grade for subjective quality.
4. **Human spot-checks** — sample weekly; trust but verify.

Run it in CI. A number that moves when you change the prompt is worth more than a
hundred vibes.`,
  },
  {
    slug: 'a-quick-tour-of-vector-databases',
    title: 'A Quick Tour of Vector Databases',
    categories: ['AI & LLMs', 'Engineering'],
    date: at(4, 30, 13, 20),
    body: `Vector databases store embeddings and answer "what's most similar to this?"
quickly, even across millions of items.

## What they optimize

- **ANN indexes** (HNSW, IVF) trade a little recall for huge speed gains.
- **Filtering** lets you combine metadata predicates with similarity search.
- **Persistence** so you don't re-embed on every restart.

## Do you even need one?

For a personal wiki, a flat file plus in-memory search is often enough. Reach for
a dedicated store when your corpus outgrows RAM or you need concurrent writes.`,
  },
  {
    slug: 'context-windows-and-cost',
    title: 'Context Windows, Tokens, and Cost',
    categories: ['AI & LLMs'],
    date: at(6, 20, 15, 10),
    body: `Every request to an LLM is billed and bounded by tokens. Understanding the budget
keeps features fast and cheap.

## Rules of thumb

- ~4 characters ≈ 1 token in English.
- You pay for input *and* output tokens.
- Bigger context isn't free — it's slower and pricier, and quality can dip.

## Tactics

- Retrieve only the chunks you need instead of stuffing everything.
- Summarize long histories before re-sending them.
- Cache stable system prompts where the provider supports it.`,
  },

  // ---------- Engineering ----------
  {
    slug: 'designing-idempotent-apis',
    title: 'Designing Idempotent APIs',
    categories: ['Engineering'],
    date: at(7, 9, 10, 25),
    body: `An idempotent endpoint can be called multiple times with the same input and
produce the same result. It's the quiet foundation of reliable systems.

## Where it matters

- Payment and order creation (retries must not double-charge).
- Webhook handlers (providers resend on timeout).
- Any client that retries on network errors.

## How to do it

\`\`\`http
POST /orders
Idempotency-Key: 6f1c2b9e-...
\`\`\`

Store the key with the first response; on a repeat, return the stored result
instead of re-executing. Expire keys after a sensible window.`,
  },
  {
    slug: 'pragmatic-guide-to-database-indexing',
    title: 'A Pragmatic Guide to Database Indexing',
    categories: ['Engineering'],
    date: at(6, 5, 11, 5),
    body: `Indexes make reads fast and writes a little slower. The art is indexing exactly
what your queries need — no more.

## Start here

- Index the columns in your \`WHERE\`, \`JOIN\`, and \`ORDER BY\` clauses.
- Composite indexes are order-sensitive: \`(a, b)\` helps \`a\` and \`a, b\`, not \`b\`.
- Covering indexes can answer a query without touching the table.

## Then measure

Read the query plan. \`EXPLAIN ANALYZE\` tells you the truth; intuition often lies.
Drop indexes nobody uses — they cost you on every write.`,
  },
  {
    slug: 'electron-app-architecture-notes',
    title: 'Electron App Architecture Notes',
    categories: ['Engineering'],
    date: at(7, 11, 9, 0),
    body: `Electron apps have two worlds: the main process (Node, full OS access) and the
renderer (the web page). Keeping the boundary clean is most of the battle.

## Principles

- Do privileged work in **main**; keep the renderer sandboxed.
- Bridge with a narrow, typed **preload** via \`contextBridge\`.
- Treat the renderer like an untrusted client of your own backend.

## A gotcha worth remembering

\`window.prompt()\` isn't implemented in the renderer — it silently returns null.
Build your own in-page dialogs for text input instead of relying on it.`,
  },
  {
    slug: 'debugging-find-the-root-cause-first',
    title: 'Debugging: Find the Root Cause First',
    categories: ['Engineering', 'Productivity'],
    date: at(5, 16, 14, 40),
    body: `The fastest way to fix a bug slowly is to guess. Systematic debugging feels
slower for five minutes and is faster for the next five hours.

## The loop

1. **Reproduce** reliably. If you can't trigger it, you can't fix it.
2. **Read the error** completely — the fix is often in the stack trace.
3. **Trace the data** backward to where the bad value originates.
4. **Change one thing**, verify, repeat.

> A fix without a root cause is just a symptom moved somewhere less visible.`,
  },
  {
    slug: 'git-workflows-for-small-teams',
    title: 'Git Workflows for Small Teams',
    categories: ['Engineering'],
    date: at(4, 24, 10, 30),
    body: `Small teams don't need heavyweight branching. Optimize for short-lived branches
and a always-releasable main.

## A simple flow

- Branch off \`main\` per change; keep it under a few days.
- Open a PR early; let CI and a reviewer catch issues.
- Squash-merge for a clean, linear history.
- Tag releases; let CI build and publish artifacts.

Reserve long-lived release branches for when you actually support multiple
versions in the wild — not before.`,
  },
  {
    slug: 'markdown-as-a-long-term-format',
    title: 'Markdown as a Long-Term Format',
    categories: ['Engineering', 'Productivity'],
    date: at(6, 2, 8, 15),
    body: `Formats come and go; plain text endures. Markdown hits the sweet spot between
human-readable and machine-parseable, which is why it's a great home for notes
you want to keep for a decade.

## Why it lasts

- Readable in any editor, on any OS, forever.
- Diff-friendly, so version control just works.
- Portable: convert to HTML, PDF, or slides when you need to.
- Frontmatter carries structured metadata without leaving plain text.`,
  },
  {
    slug: 'observability-basics',
    title: 'Observability Basics: Logs, Metrics, Traces',
    categories: ['Engineering'],
    date: at(5, 28, 15, 55),
    body: `You can't fix what you can't see. Observability is the practice of making a
system explain itself.

## The three pillars

- **Logs** — discrete events, great for the specific "what happened here."
- **Metrics** — aggregates over time; cheap to store, perfect for alerts.
- **Traces** — the path of a single request across services.

Start with structured logs and a few golden metrics (latency, errors, saturation)
before reaching for anything fancier.`,
  },

  // ---------- Product ----------
  {
    slug: 'writing-prds-people-read',
    title: 'Writing PRDs People Actually Read',
    categories: ['Product'],
    date: at(7, 7, 9, 35),
    body: `A PRD earns its length in clarity, not word count. If the team can't skim it in
five minutes, it won't get read — and unread specs cause the bugs they were meant
to prevent.

## A lean structure

- **Problem** — who hurts, and how much.
- **Goal & non-goals** — draw the boundary explicitly.
- **Solution sketch** — the smallest thing that works.
- **Success metric** — how you'll know it worked.

Cut everything else. Link out for detail; keep the spine short.`,
  },
  {
    slug: 'jobs-to-be-done',
    title: 'The Jobs-to-be-Done Framework',
    categories: ['Product', 'Reading Notes'],
    date: at(6, 15, 13, 10),
    body: `People don't buy products; they "hire" them to make progress in a situation.
JTBD reframes features around the job, not the demographic.

## The template

> When I ___ (situation), I want to ___ (motivation), so I can ___ (outcome).

## Why it helps

- Surfaces the real competition (often a spreadsheet or "doing nothing").
- Keeps you focused on outcomes, not feature checklists.
- Makes prioritization arguments concrete.`,
  },
  {
    slug: 'onboarding-first-five-minutes',
    title: 'Onboarding: The First Five Minutes',
    categories: ['Product'],
    date: at(5, 4, 10, 50),
    body: `New users decide fast. The first session should deliver one real "aha" before it
asks for anything in return.

## Guidelines

- Show value before setup; defer accounts and settings.
- Pre-fill sample content so the app is never empty.
- One primary action per screen; hide the rest.
- Celebrate the first success — it earns the next step.

An empty state is a missed first impression. Seed it.`,
  },
  {
    slug: 'pricing-open-source-software',
    title: 'Pricing Open-Source Software',
    categories: ['Product'],
    date: at(4, 20, 11, 15),
    body: `Open source and revenue aren't opposites. The question is which value you give
away and which you charge for.

## Common models

- **Open core** — free base, paid advanced features.
- **Hosted** — you sell the convenience of not self-hosting.
- **Dual license** — AGPL for the community, commercial for companies that can't comply.
- **Support & services** — sell certainty, not code.

Pick the boundary that matches who benefits most — and be transparent about it.`,
  },
  {
    slug: 'knowledge-bases-that-dont-rot',
    title: "Knowledge Bases That Don't Rot",
    categories: ['Product', 'Productivity'],
    date: at(7, 15, 8, 30),
    body: `The problem with note-taking was never capture — it's everything after: cleaning,
categorizing, and finding things again. Most knowledge bases decay because
maintenance is manual and boring.

## Designing against rot

- **Automate tidying** so formatting stays consistent without effort.
- **Auto-categorize** on save; don't make filing a chore.
- **Search by meaning**, not just exact words you typed months ago.
- **Keep it open** (plain Markdown) so nothing traps your data.

Capture should be effortless. Maintenance should be invisible.`,
  },

  // ---------- Reading Notes ----------
  {
    slug: 'notes-thinking-fast-and-slow',
    title: "Notes on 'Thinking, Fast and Slow'",
    categories: ['Reading Notes'],
    date: at(6, 8, 20, 10),
    body: `Kahneman splits the mind into System 1 (fast, intuitive) and System 2 (slow,
deliberate). Most of our errors come from trusting System 1 where System 2 was
needed.

## Ideas that stuck

- **Anchoring** — the first number you see drags every later estimate.
- **Availability** — vivid examples feel more probable than they are.
- **Loss aversion** — losing $100 hurts more than gaining $100 pleases.

## Applied

Slow down for high-stakes, low-frequency decisions. Build checklists so System 2
doesn't have to be summoned from scratch each time.`,
  },
  {
    slug: 'notes-making-of-a-manager',
    title: "Notes on 'The Making of a Manager'",
    categories: ['Reading Notes', 'Career'],
    date: at(5, 19, 21, 0),
    body: `Julie Zhuo's field guide to becoming a manager, especially the accidental,
first-time kind. The job is not doing the work — it's improving the team that does.

## Takeaways

- Your job is **outcomes through others**, not personal output.
- Feedback is a gift; give it early, specific, and often.
- Great 1:1s are the report's meeting, not yours.
- Hire for trajectory and values, not just current skill.`,
  },
  {
    slug: 'notes-ddia',
    title: "Notes on 'Designing Data-Intensive Applications'",
    categories: ['Reading Notes', 'Engineering'],
    date: at(4, 27, 19, 30),
    body: `Kleppmann's book is the map of the modern data landscape: reliability,
scalability, and maintainability, explained from first principles.

## Anchors

- **Replication vs partitioning** solve different problems; you often need both.
- **Consistency models** are trade-offs, not a ladder to "best."
- **Logs** are a shockingly powerful primitive (databases, queues, streams).

The recurring lesson: there is no free lunch, only trade-offs you choose on purpose.`,
  },
  {
    slug: 'notes-deep-work',
    title: "Notes on 'Deep Work'",
    categories: ['Reading Notes', 'Productivity'],
    date: at(6, 24, 20, 45),
    body: `Cal Newport argues that the ability to focus without distraction on a hard task
is both increasingly rare and increasingly valuable.

## Practices

- **Schedule** deep blocks; don't wait for inspiration.
- **Ritualize** where and how you work to lower start-up cost.
- **Embrace boredom** — training attention means resisting the urge to switch.
- **Drain the shallows** — batch email and meetings into the margins.`,
  },

  // ---------- Productivity ----------
  {
    slug: 'building-a-second-brain',
    title: 'Building a Second Brain',
    categories: ['Productivity'],
    date: at(7, 4, 9, 20),
    body: `A "second brain" is an external system for capturing and organizing what you
learn so your biological brain can focus on thinking, not remembering.

## The CODE method

1. **Capture** — keep what resonates, ignore the rest.
2. **Organize** — file by actionability, not just topic.
3. **Distill** — highlight the essence for your future self.
4. **Express** — turn notes into output that matters.

The goal isn't to hoard information. It's to make your best ideas reusable.`,
  },
  {
    slug: 'weekly-review-template',
    title: 'A Weekly Review Template',
    categories: ['Productivity'],
    date: at(5, 31, 17, 30),
    body: `Thirty minutes on Friday keeps the next week from running you. This is the
checklist I actually use.

## The review

- Clear the inboxes (email, notes, downloads) to zero.
- Review last week's wins and one lesson learned.
- Look at the calendar two weeks out; prep or decline.
- Pick **three** priorities for next week — no more.

> If everything is a priority, nothing is.`,
  },
  {
    slug: 'taming-your-inbox',
    title: 'Taming Your Inbox',
    categories: ['Productivity'],
    date: at(4, 22, 8, 55),
    body: `Email is other people's to-do list for you. A few rules keep it from becoming
your whole day.

## Rules

- Check on a schedule, not on every notification.
- Touch each message once: do, delegate, defer, or delete.
- Keep replies to five sentences; link to a doc for anything longer.
- Unsubscribe ruthlessly — the best filter is less mail.`,
  },
  {
    slug: 'the-two-minute-rule',
    title: 'The Two-Minute Rule',
    categories: ['Productivity'],
    date: at(6, 18, 12, 0),
    body: `Two versions of the same idea, both useful. From GTD: if a task takes less than
two minutes, do it now instead of tracking it. From Atomic Habits: shrink a new
habit until it takes two minutes to start.

## Why it works

- Removes the overhead of capturing trivial tasks.
- Lowers the activation energy for habits you keep avoiding.
- "Read one page" beats "read for an hour" you never begin.`,
  },

  // ---------- Career ----------
  {
    slug: 'running-1-1s-that-dont-suck',
    title: "Running 1:1s That Don't Suck",
    categories: ['Career'],
    date: at(7, 1, 15, 40),
    body: `A 1:1 is the report's meeting, not a status update you extract. Done well, it's
the highest-leverage half hour on a manager's calendar.

## Make it count

- Let them set most of the agenda.
- Ask about obstacles, growth, and energy — not just tickets.
- Listen more than you talk; silence invites the real topic.
- End with clear, mutual next steps.`,
  },
  {
    slug: 'how-to-give-technical-feedback',
    title: 'How to Give Technical Feedback',
    categories: ['Career'],
    date: at(5, 12, 11, 25),
    body: `Good feedback improves the work without bruising the person. In code review,
tone and specificity do the heavy lifting.

## Guidelines

- Critique the code, not the coder.
- Be specific: show the line and suggest an alternative.
- Separate **blocking** from **nice-to-have**; label them.
- Praise good decisions too — reviews aren't only for defects.`,
  },
  {
    slug: 'learning-in-public',
    title: 'Learning in Public',
    categories: ['Career', 'Productivity'],
    date: at(6, 30, 10, 15),
    body: `Sharing what you're learning — notes, posts, small projects — compounds faster
than learning in private. Teaching forces clarity, and clarity reveals gaps.

## How to start

- Write the note you wish you'd found.
- Ship small and often; polish later.
- Document the messy middle, not just the wins.
- Let feedback correct you — being wrong in public is a shortcut to being right.`,
  },
];

async function main() {
  await fs.mkdir(path.join(targetDir, 'notes'), { recursive: true });
  let written = 0;
  for (const n of notes) {
    const rel = path.join('notes', `${n.slug}.md`);
    const abs = path.join(targetDir, rel);
    const file = matter.stringify(`\n${n.body.trim()}\n`, {
      title: n.title,
      categories: n.categories,
      savedAt: n.date,
    });
    await fs.writeFile(abs, file, 'utf8');
    written += 1;
  }
  const cats = [...new Set(notes.flatMap((n) => n.categories))].sort();
  console.log(`Wrote ${written} notes to ${path.join(targetDir, 'notes')}`);
  console.log(`Categories (${cats.length}): ${cats.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
