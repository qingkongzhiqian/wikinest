import {
  listFlat, readNote, writeNote, deleteNote, searchNotes, CONTENT_DIR,
} from './core/store.js';
import { autoTagIfEmpty } from './core/classify.js';
import { tidyAndSet, synthesizeCategory } from './core/organize.js';

const HELP = `Wikinest CLI

Usage:
  wiki serve [--port N]        Start the web server (view + edit)
  wiki mcp                     Start the MCP server (stdio)
  wiki add <path> [text]       Add a note; text from arg, or piped stdin, or opens empty
  wiki append <path> [text]    Append to an existing note (stdin supported)
  wiki cat <path>              Print a note's raw markdown
  wiki ls                      List all note paths
  wiki search <query>          Full-text search
  wiki tidy <path>             AI-clean a note's formatting in place
  wiki digest <category>       Synthesize all notes in a category into one article
  wiki rm <path>               Delete a note

Notes live in: ${CONTENT_DIR}
Paths support subfolders, e.g. "journal/2026-07-06". The ".md" is optional.

Examples:
  echo "# Hello" | wiki add journal/today
  wiki search "mcp"
`;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case 'serve': {
      const portIdx = rest.indexOf('--port');
      const port = portIdx !== -1 ? Number(rest[portIdx + 1]) : Number(process.env.WIKI_PORT) || 4321;
      const { startServer } = await import('./web/server.js');
      await startServer({ port });
      break;
    }

    case 'mcp': {
      const { startMcp } = await import('./mcp/server.js');
      await startMcp();
      break;
    }

    case 'add':
    case 'append': {
      const path = rest[0];
      if (!path) return fail('path required');
      let text = rest.slice(1).join(' ');
      if (!text) text = await readStdin();
      const saved = await writeNote(path, text, { mode: cmd === 'append' ? 'append' : 'overwrite' });
      console.log(`${cmd === 'append' ? 'Appended to' : 'Wrote'} ${saved}`);
      const cats = await autoTagIfEmpty(saved);
      if (cats.length) console.log(`分类: ${cats.join('、')}`);
      break;
    }

    case 'cat': {
      if (!rest[0]) return fail('path required');
      const note = await readNote(rest[0]);
      process.stdout.write(note.raw);
      break;
    }

    case 'ls': {
      const paths = await listFlat();
      console.log(paths.join('\n') || '(empty wiki)');
      break;
    }

    case 'search': {
      const q = rest.join(' ');
      if (!q) return fail('query required');
      const hits = await searchNotes(q);
      if (!hits.length) return console.log('No matches.');
      for (const h of hits) console.log(`${h.path}\n  ${h.snippet}\n`);
      break;
    }

    case 'tidy': {
      if (!rest[0]) return fail('path required');
      const r = await tidyAndSet(rest[0]);
      console.log(`Tidied ${r.path}`);
      break;
    }

    case 'digest': {
      const category = rest.join(' ').trim();
      if (!category) return fail('category required');
      const r = await synthesizeCategory(category);
      console.log(`Digest written to ${r.path} (from ${r.sourceCount} notes)`);
      break;
    }

    case 'rm': {
      if (!rest[0]) return fail('path required');
      await deleteNote(rest[0]);
      console.log(`Deleted ${rest[0]}`);
      break;
    }

    case 'help':
    case '--help':
    case undefined:
      console.log(HELP);
      break;

    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function fail(msg) {
  console.error('Error: ' + msg);
  process.exitCode = 1;
}
