export const normalizeTerm = text => text.normalize('NFKC').toLowerCase().trim()

let words
export function tokenize(text) {
  words ??= new Intl.Segmenter('zh', { granularity: 'word' })
  return [...new Set(Array.from(words.segment(normalizeTerm(text)))
    .filter(word => word.isWordLike).map(word => word.segment))]
}

// Public labels may name routes, package scopes and technical parameters.
// Allow only the listed characters, even when an older record skipped validation.
export function isPublicTitle(title) {
  return typeof title === 'string' && title.trim().length > 0 && [...title].length <= 60
    && !/[^\p{L}\p{N}\p{M} _.,，。:：()（）+、·｜/&@#\[\]-]/u.test(title)
    && !/:\/\/|(?:^|\s)(?:\/\/\S|mailto:\S|www\.\S)/u.test(normalizeTerm(title))
}
