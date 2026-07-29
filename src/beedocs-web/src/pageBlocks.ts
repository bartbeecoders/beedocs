import { serializeBeeDoc, EMPTY_BEE_DOC, createNode } from './diagram/beeModel'
import type { ContentSegment } from './markdownFences'

export type InsertKind =
  | 'section'
  | 'subsection'
  | 'paragraph'
  | 'bullet-list'
  | 'numbered-list'
  | 'table'
  | 'callout'
  | 'beediagram'
  | 'mermaid-flow'
  | 'mermaid-sequence'
  | 'mermaid-er'

function starterBeeSource(): string {
  const a = createNode('person', 80, 120)
  a.label = 'Actor'
  const b = createNode('system', 320, 120)
  b.label = 'System'
  const c = createNode('database', 560, 120)
  c.label = 'Store'
  return serializeBeeDoc({
    ...structuredClone(EMPTY_BEE_DOC),
    nodes: [a, b, c],
    edges: [
      { id: 'e1', from: a.id, to: b.id, label: 'uses' },
      { id: 'e2', from: b.id, to: c.id, label: 'reads/writes' },
    ],
  })
}

/** Markdown/fence segments to append for a given insert kind */
export function segmentsForInsert(kind: InsertKind, opts?: { diagramId?: string; title?: string }): ContentSegment[] {
  const title = opts?.title?.trim() || 'New section'
  switch (kind) {
    case 'section':
      return [{ type: 'text', text: `\n\n## ${title}\n\nDescribe this section…\n\n` }]
    case 'subsection':
      return [{ type: 'text', text: `\n\n### ${title}\n\nDetails…\n\n` }]
    case 'paragraph':
      return [{ type: 'text', text: `\n\nWrite your paragraph here.\n\n` }]
    case 'bullet-list':
      return [
        {
          type: 'text',
          text: `\n\n- First item\n- Second item\n- Third item\n\n`,
        },
      ]
    case 'numbered-list':
      return [
        {
          type: 'text',
          text: `\n\n1. First step\n2. Second step\n3. Third step\n\n`,
        },
      ]
    case 'table':
      return [
        {
          type: 'text',
          text: `\n\n| Column | Value |\n| --- | --- |\n| Example | … |\n\n`,
        },
      ]
    case 'callout':
      return [
        {
          type: 'text',
          text: `\n\n> **Note:** Add an important callout here.\n\n`,
        },
      ]
    case 'beediagram':
      return [
        { type: 'text', text: `\n\n### Architecture\n\n` },
        { type: 'fence', lang: 'beediagram', body: starterBeeSource() },
        { type: 'text', text: `\n\n` },
      ]
    case 'mermaid-flow':
      return [
        { type: 'text', text: `\n\n### Flow\n\n` },
        {
          type: 'fence',
          lang: 'mermaid',
          body: `flowchart LR\n  A[Start] --> B[Step]\n  B --> C[End]`,
        },
        { type: 'text', text: `\n\n` },
      ]
    case 'mermaid-sequence':
      return [
        { type: 'text', text: `\n\n### Sequence\n\n` },
        {
          type: 'fence',
          lang: 'mermaid',
          body: `sequenceDiagram\n  participant User\n  participant API\n  User->>API: Request\n  API-->>User: Response`,
        },
        { type: 'text', text: `\n\n` },
      ]
    case 'mermaid-er':
      return [
        { type: 'text', text: `\n\n### Data model\n\n` },
        {
          type: 'fence',
          lang: 'mermaid',
          body: `erDiagram\n  BOOK ||--o{ PAGE : contains\n  PAGE ||--o{ DIAGRAM : embeds`,
        },
        { type: 'text', text: `\n\n` },
      ]
    default:
      return [{ type: 'text', text: '\n\n' }]
  }
}

/** Linked diagram: fence only (caller creates the diagram entity) */
export function segmentsForLinkedDiagram(diagramId: string, title?: string): ContentSegment[] {
  const heading = title?.trim() ? title.trim() : 'Linked diagram'
  return [
    { type: 'text', text: `\n\n### ${heading}\n\n` },
    { type: 'fence', lang: 'beediagram-ref', body: diagramId },
    { type: 'text', text: `\n\n` },
  ]
}
