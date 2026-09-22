import type { Lang } from '../langs'

/** "Cloud points" — the word cloud on the book and shelf overviews (WordCloud.tsx). */
const en = {
  'cloud.title': 'Cloud points',
  'cloud.subtitle': 'The most used words across {n} documents — the bigger, the more often. Click a word to search for it.',
  'cloud.subtitleOne': 'The most used words in 1 document — the bigger, the more often. Click a word to search for it.',
  'cloud.empty': 'Not enough text here yet to build a word cloud.',
  'cloud.wordTitle': '“{word}” — {count} times in {docs} documents',
  'cloud.aria': 'Most used words',
  'cloud.hide': 'Hide',
  'cloud.show': 'Show',
} as const

type Msgs = Record<keyof typeof en, string>

const fr: Msgs = {
  'cloud.title': 'Nuage de mots',
  'cloud.subtitle': 'Les mots les plus utilisés dans {n} documents — plus ils sont grands, plus ils reviennent. Cliquez sur un mot pour le rechercher.',
  'cloud.subtitleOne': 'Les mots les plus utilisés dans 1 document — plus ils sont grands, plus ils reviennent. Cliquez sur un mot pour le rechercher.',
  'cloud.empty': 'Pas encore assez de texte ici pour former un nuage de mots.',
  'cloud.wordTitle': '« {word} » — {count} fois dans {docs} documents',
  'cloud.aria': 'Mots les plus utilisés',
  'cloud.hide': 'Masquer',
  'cloud.show': 'Afficher',
}

const de: Msgs = {
  'cloud.title': 'Wortwolke',
  'cloud.subtitle': 'Die häufigsten Wörter in {n} Dokumenten — je größer, desto öfter. Klicken Sie auf ein Wort, um danach zu suchen.',
  'cloud.subtitleOne': 'Die häufigsten Wörter in 1 Dokument — je größer, desto öfter. Klicken Sie auf ein Wort, um danach zu suchen.',
  'cloud.empty': 'Hier gibt es noch nicht genug Text für eine Wortwolke.',
  'cloud.wordTitle': '„{word}“ — {count}-mal in {docs} Dokumenten',
  'cloud.aria': 'Häufigste Wörter',
  'cloud.hide': 'Ausblenden',
  'cloud.show': 'Einblenden',
}

const es: Msgs = {
  'cloud.title': 'Nube de palabras',
  'cloud.subtitle': 'Las palabras más usadas en {n} documentos: cuanto más grandes, más frecuentes. Haz clic en una palabra para buscarla.',
  'cloud.subtitleOne': 'Las palabras más usadas en 1 documento: cuanto más grandes, más frecuentes. Haz clic en una palabra para buscarla.',
  'cloud.empty': 'Todavía no hay suficiente texto aquí para formar una nube de palabras.',
  'cloud.wordTitle': '«{word}»: {count} veces en {docs} documentos',
  'cloud.aria': 'Palabras más usadas',
  'cloud.hide': 'Ocultar',
  'cloud.show': 'Mostrar',
}

const nl: Msgs = {
  'cloud.title': 'Woordwolk',
  'cloud.subtitle': 'De meest gebruikte woorden in {n} documenten — hoe groter, hoe vaker. Klik op een woord om ernaar te zoeken.',
  'cloud.subtitleOne': 'De meest gebruikte woorden in 1 document — hoe groter, hoe vaker. Klik op een woord om ernaar te zoeken.',
  'cloud.empty': 'Hier staat nog niet genoeg tekst voor een woordwolk.',
  'cloud.wordTitle': '“{word}” — {count} keer in {docs} documenten',
  'cloud.aria': 'Meest gebruikte woorden',
  'cloud.hide': 'Verbergen',
  'cloud.show': 'Tonen',
}

const ja: Msgs = {
  'cloud.title': 'ワードクラウド',
  'cloud.subtitle': '{n} 件のドキュメントでよく使われている単語です。大きいほど頻繁に使われています。単語をクリックすると検索します。',
  'cloud.subtitleOne': '1 件のドキュメントでよく使われている単語です。大きいほど頻繁に使われています。単語をクリックすると検索します。',
  'cloud.empty': 'ワードクラウドを作るにはまだテキストが足りません。',
  'cloud.wordTitle': '「{word}」— {docs} 件のドキュメントで {count} 回',
  'cloud.aria': 'よく使われている単語',
  'cloud.hide': '非表示',
  'cloud.show': '表示',
}

const zh: Msgs = {
  'cloud.title': '词云',
  'cloud.subtitle': '{n} 个文档中最常用的词——字越大，用得越多。点击一个词即可搜索。',
  'cloud.subtitleOne': '1 个文档中最常用的词——字越大，用得越多。点击一个词即可搜索。',
  'cloud.empty': '这里的文本还不够生成词云。',
  'cloud.wordTitle': '“{word}”——在 {docs} 个文档中出现 {count} 次',
  'cloud.aria': '最常用的词',
  'cloud.hide': '隐藏',
  'cloud.show': '显示',
}

export const cloud = { en, fr, de, es, nl, ja, zh } satisfies Record<Lang, Msgs>
