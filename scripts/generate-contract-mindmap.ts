import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildMindMapSvg, type MindMapNode, toLeafNodes } from './lib/mindmap-svg';
import { DashboardPreviewSectionHeader } from '@/features/dashboard/components/DashboardPreviewSectionHeader';

interface AnchorIdl {
  instructions: { name: string }[];
  accounts: { name: string }[];
  events: { name: string }[];
  errors: { name: string }[];
  types: { name: string }[];
}

const GENERATED_DIR = join(process.cwd(), 'src/solana/generated/story/src/generated');
const STORY_IDL_PATH = join(process.cwd(), 'src/abis/Story.json');

function listGeneratedTsNames(subdir: string): string[] {
  const dir = join(GENERATED_DIR, subdir);

  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

function parseGeneratedErrorNames(): string[] {
  const content = readFileSync(join(GENERATED_DIR, 'errors/story.ts'), 'utf8');
  const names: string[] = [];
  const regex = /\/\*\* (\w+):/g;

  let match = regex.exec(content);

  while (match) {
    names.push(match[1]);
    match = regex.exec(content);
  }

  return names;
}

function readStoryIdl(): AnchorIdl {
  return JSON.parse(readFileSync(STORY_IDL_PATH, 'utf8')) as AnchorIdl;
}

function buildStoryIdlTypes(idl: AnchorIdl): string[] {
  const accountNames = new Set(idl.accounts.map((item) => item.name));
  const eventNames = new Set(idl.events.map((item) => item.name));

  return idl.types
    .map((item) => item.name)
    .filter((name) => !accountNames.has(name) && !eventNames.has(name))
    .sort();
}

function buildContractMindMap(): MindMapNode {
  const storyIdl = readStoryIdl();

  return {
    name: 'Contracts',
    children: [
      {
        name: 'Solana Story',
        children: [
          {
            name: 'IDL (Story.json)',
            children: [
              {
                name: 'Instructions',
                children: toLeafNodes(
                  storyIdl.instructions.map((item) => item.name).sort(),
                ),
              },
              {
                name: 'Accounts',
                children: toLeafNodes(storyIdl.accounts.map((item) => item.name).sort()),
              },
              {
                name: 'Types',
                children: toLeafNodes(buildStoryIdlTypes(storyIdl)),
              },
              {
                name: 'Events',
                children: toLeafNodes(storyIdl.events.map((item) => item.name).sort()),
              },
              {
                name: 'Errors',
                children: toLeafNodes(storyIdl.errors.map((item) => item.name).sort()),
              },
            ],
          },
          {
            name: 'Generated (Codama)',
            children: [
              {
                name: 'Instructions',
                children: toLeafNodes(listGeneratedTsNames('instructions')),
              },
              {
                name: 'Accounts',
                children: toLeafNodes(listGeneratedTsNames('accounts')),
              },
              {
                name: 'PDAs',
                children: toLeafNodes(listGeneratedTsNames('pdas')),
              },
              {
                name: 'Types',
                children: toLeafNodes(listGeneratedTsNames('types')),
              },
              {
                name: 'Errors',
                children: toLeafNodes(parseGeneratedErrorNames()),
              },
            ],
          },
        ],
      },
    ],
  };
}

const outputPath = join(process.cwd(), 'docs', 'contract-mindmap.svg');
const svg = buildMindMapSvg(buildContractMindMap(), 'Contract Mind Map');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, svg, 'utf8');
console.log('SVG generated at docs/contract-mindmap.svg');



DashboardPreviewSectionHeader

DashboardPreviewSectionHeader


dsadsadhk