// Custom shiki (TextMate) theme "obsidian-dark", tuned to the Obsidian tokens (SPEC §5).
// Owner: ui-foundation.
import type { ThemeRegistration } from 'shiki/core';

export const OB_CODE_COLORS = {
  bg: '#0E171C',
  fg: '#D5DEE3',
  comment: '#62737E',
  keyword: '#B3A6E8', // violet
  fn: '#8FB8DE', // accent ice-blue
  string: '#9DD4B0', // soft mint
  number: '#E3BE7A', // amber
  type: '#7FC8D2', // teal
  variable: '#DCE4E8',
  property: '#BCCBD4',
  punctuation: '#8496A2',
  tag: '#F0858B',
  attr: '#E3BE7A',
  regex: '#F2A47A',
  inserted: '#5FD39A',
  deleted: '#F07178',
} as const;

const c = OB_CODE_COLORS;

export const obsidianShikiTheme: ThemeRegistration = {
  name: 'obsidian-dark',
  type: 'dark',
  colors: {
    'editor.background': c.bg,
    'editor.foreground': c.fg,
  },
  fg: c.fg,
  bg: c.bg,
  settings: [
    { settings: { foreground: c.fg, background: c.bg } },
    { scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: c.comment, fontStyle: 'italic' } },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
        'keyword.other.special-method',
        'variable.language',
      ],
      settings: { foreground: c.keyword },
    },
    { scope: ['keyword.operator', 'punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'], settings: { foreground: c.punctuation } },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function', 'entity.name.method', 'support.function.builtin'],
      settings: { foreground: c.fn },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string', 'markup.inline.raw', 'string.unquoted'],
      settings: { foreground: c.string },
    },
    { scope: ['string.regexp', 'constant.other.character-class.regexp', 'constant.character.escape'], settings: { foreground: c.regex } },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.language.boolean', 'constant.other', 'support.constant', 'constant.character'],
      settings: { foreground: c.number },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'storage.type.primitive',
        'entity.name.namespace',
        'entity.name.type.module',
      ],
      settings: { foreground: c.type },
    },
    { scope: ['variable', 'variable.other', 'variable.parameter', 'meta.definition.variable'], settings: { foreground: c.variable } },
    {
      scope: ['variable.other.property', 'variable.other.object.property', 'support.variable.property', 'meta.object-literal.key', 'support.type.property-name', 'entity.name.tag.yaml'],
      settings: { foreground: c.property },
    },
    { scope: ['entity.name.tag', 'meta.tag.sgml', 'punctuation.definition.tag'], settings: { foreground: c.tag } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: c.attr } },
    { scope: ['support.type.property-name.json', 'support.type.property-name.json.comments'], settings: { foreground: c.fn } },
    { scope: ['markup.heading', 'markup.heading entity.name'], settings: { foreground: c.fn, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: c.fn } },
    { scope: ['markup.list punctuation.definition.list'], settings: { foreground: c.keyword } },
    { scope: ['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted'], settings: { foreground: c.inserted } },
    { scope: ['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted'], settings: { foreground: c.deleted } },
    { scope: ['meta.diff.range', 'meta.diff.header'], settings: { foreground: c.keyword } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: c.deleted } },
    { scope: ['entity.name.section', 'entity.name.tag.toml', 'support.type.property-name.toml'], settings: { foreground: c.fn } },
    { scope: ['variable.other.env', 'variable.other.normal.shell', 'punctuation.definition.variable.shell'], settings: { foreground: c.type } },
  ],
};
