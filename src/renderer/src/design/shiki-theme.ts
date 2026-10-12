// Custom shiki (TextMate) theme "obsidian-m13": MONOCHROME — greys and cold white only. Colour is reserved for
// status in M13 (SPEC §5), so syntax is carried by tone and weight: keywords/functions in ink, strings in the cold
// accent, comments in --t3 italic. The only hues are diff insert/delete, which ARE status. Owner: ui-foundation.
import type { ThemeRegistration } from 'shiki/core';

export const OB_CODE_COLORS = {
  bg: '#07070A', // --s1 well
  fg: '#ADADB6', // --t2 — plain identifiers and text
  comment: '#7A7A85', // --t3
  keyword: '#FFFFFF', // --t1 ink
  fn: '#E6EEFF', // --acc cold white
  string: '#C9D2E3', // cold light grey (a step under the accent)
  number: '#E6EEFF', // --acc
  type: '#D6D6DC', // light grey
  variable: '#ADADB6', // --t2
  property: '#C2C2CA', // between t2 and t1
  punctuation: '#7A7A85', // --t3
  tag: '#FFFFFF',
  attr: '#C2C2CA',
  regex: '#C9D2E3',
  inserted: '#3BE07A', // --ok (status)
  deleted: '#FF6F62', // --err (status)
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
    { scope: ['support.type.property-name.json', 'support.type.property-name.json.comments'], settings: { foreground: c.property } },
    { scope: ['markup.heading', 'markup.heading entity.name'], settings: { foreground: c.keyword, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: c.fn } },
    { scope: ['markup.list punctuation.definition.list'], settings: { foreground: c.punctuation } },
    { scope: ['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted'], settings: { foreground: c.inserted } },
    { scope: ['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted'], settings: { foreground: c.deleted } },
    { scope: ['meta.diff.range', 'meta.diff.header'], settings: { foreground: c.comment } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: c.deleted } },
    { scope: ['entity.name.section', 'entity.name.tag.toml', 'support.type.property-name.toml'], settings: { foreground: c.keyword } },
    { scope: ['variable.other.env', 'variable.other.normal.shell', 'punctuation.definition.variable.shell'], settings: { foreground: c.fn } },
  ],
};
