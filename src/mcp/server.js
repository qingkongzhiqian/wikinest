import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  listFlat, readNote, writeNote, searchNotes, CONTENT_DIR,
} from '../core/store.js';
import { autoTagIfEmpty } from '../core/classify.js';
import { tidyMarkdown, tidyAndSet, synthesizeCategory, isOrganizeConfigured } from '../core/organize.js';
import { askWiki, isRagConfigured } from '../core/rag.js';

export function createMcpServer() {
  const server = new McpServer({
    name: 'personal-wiki',
    version: '1.0.0',
  });

  // The headline tool: save an AI conversation as a note.
  server.registerTool(
    'save_conversation',
    {
      title: 'Save conversation to wiki',
      description:
        'Save a conversation or piece of writing into the personal wiki as a markdown note. ' +
        'Use this at the end of a chat to archive what was discussed. Choose a descriptive ' +
        'path with subfolders, e.g. "chats/2026-07-06-mcp-setup".',
      inputSchema: {
        path: z.string().describe('Wiki-relative path, subfolders allowed, e.g. "chats/2026-07-06-topic". ".md" optional.'),
        title: z.string().optional().describe('Human-readable title stored in frontmatter.'),
        content: z.string().describe('The conversation / note body in markdown.'),
        tags: z.array(z.string()).optional().describe('Optional tags stored in frontmatter.'),
        mode: z.enum(['overwrite', 'append', 'skip']).optional()
          .describe('overwrite (default), append to existing, or skip if it exists.'),
        tidy: z.boolean().optional()
          .describe('If true, let AI clean up the formatting/typesetting before saving (facts unchanged).'),
      },
    },
    async ({ path, title, content, tags, mode, tidy }) => {
      let body = content;
      if (tidy && isOrganizeConfigured()) {
        try { body = await tidyMarkdown({ title: title || '', content }); }
        catch (e) { console.error('tidy failed, saving raw:', e.message); }
      }
      const frontmatter = { savedAt: new Date().toISOString() };
      if (title) frontmatter.title = title;
      if (tags?.length) frontmatter.tags = tags;
      if (tidy && body !== content) frontmatter.tidied = true;
      const saved = await writeNote(path, body, { frontmatter, mode: mode || 'overwrite' });
      const cats = await autoTagIfEmpty(saved);
      const tagMsg = cats.length ? ` (分类: ${cats.join('、')})` : '';
      return { content: [{ type: 'text', text: `Saved to ${saved}${tagMsg}` }] };
    },
  );

  server.registerTool(
    'write_note',
    {
      title: 'Write a note',
      description: 'Create or update any markdown note in the wiki.',
      inputSchema: {
        path: z.string().describe('Wiki-relative path, subfolders allowed.'),
        content: z.string().describe('Markdown body.'),
        mode: z.enum(['overwrite', 'append', 'skip']).optional(),
      },
    },
    async ({ path, content, mode }) => {
      const saved = await writeNote(path, content, { mode: mode || 'overwrite' });
      const cats = await autoTagIfEmpty(saved);
      const tagMsg = cats.length ? ` (分类: ${cats.join('、')})` : '';
      return { content: [{ type: 'text', text: `Wrote ${saved}${tagMsg}` }] };
    },
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description: 'Read the raw markdown of a note by path.',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const note = await readNote(path);
      return { content: [{ type: 'text', text: note.raw }] };
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'List every note path in the wiki.',
      inputSchema: {},
    },
    async () => {
      const paths = await listFlat();
      return { content: [{ type: 'text', text: paths.join('\n') || '(empty wiki)' }] };
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description: 'Full-text search across all notes; returns matching paths with snippets.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const hits = await searchNotes(query);
      const text = hits.length
        ? hits.map((h) => `- ${h.path}: ${h.snippet}`).join('\n')
        : 'No matches.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'tidy_note',
    {
      title: 'Tidy a note',
      description:
        'Let AI clean up an existing note\'s formatting/typesetting in place ' +
        '(headings, lists, code blocks, punctuation). Facts are preserved, not rewritten.',
      inputSchema: { path: z.string().describe('Wiki-relative path of the note to tidy.') },
    },
    async ({ path }) => {
      const r = await tidyAndSet(path);
      return { content: [{ type: 'text', text: `Tidied ${r.path}` }] };
    },
  );

  server.registerTool(
    'synthesize_category',
    {
      title: 'Synthesize a category digest',
      description:
        'Aggregate every note in a category into one cohesive digest article, ' +
        'saved under digests/<category>.md. Run after adding notes to keep the digest fresh.',
      inputSchema: { category: z.string().describe('The category name to synthesize.') },
    },
    async ({ category }) => {
      const r = await synthesizeCategory(category);
      return { content: [{ type: 'text', text: `Digest written to ${r.path} (from ${r.sourceCount} notes)` }] };
    },
  );

  server.registerTool(
    'ask_wiki',
    {
      title: 'Ask your wiki',
      description:
        'Answer a natural-language question using semantic search over the user\'s notes. '
        + 'Returns an answer grounded in the notes with a "参考来源" list of source paths. '
        + 'Use this to recall what the user previously wrote or discussed.',
      inputSchema: { question: z.string().describe('The natural-language question to answer from the wiki.') },
    },
    async ({ question }) => {
      if (!isRagConfigured()) {
        return { content: [{ type: 'text', text: '语义问答未配置(需要 EMBED_* 或复用 LLM 配置)。' }] };
      }
      const r = await askWiki(question);
      return { content: [{ type: 'text', text: r.answer }] };
    },
  );

  return server;
}

export async function startMcp() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  console.error(`personal-wiki MCP server ready (content: ${CONTENT_DIR})`);
}
