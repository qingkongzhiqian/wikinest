export const SINGLE_SOURCE_LANGUAGE_RULE =
  'Write the output in the same language as the source document.';

export const MULTI_SOURCE_LANGUAGE_RULE =
  'Write the output in the dominant language across the source documents.';

export const QA_LANGUAGE_RULE =
  'Answer in the dominant language of the retrieved sources. If there is no clear dominant language, use the language of the user question.';

export function isHanDominant(text) {
  const value = String(text || '');
  const han = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return han > latin;
}

export function referenceHeadingFor(text) {
  return isHanDominant(text) ? '参考来源' : 'Sources';
}

export function isHanDocumentMajority(documents, fallbackText = '') {
  const votes = (documents || []).reduce(
    (out, document) => {
      out[isHanDominant(document) ? 0 : 1]++;
      return out;
    },
    [0, 0],
  );
  if (votes[0] === votes[1]) return isHanDominant(fallbackText);
  return votes[0] > votes[1];
}

export function referenceHeadingForDocuments(documents, fallbackText = '') {
  return isHanDocumentMajority(documents, fallbackText) ? '参考来源' : 'Sources';
}

export function noResultsMessageFor(question) {
  return isHanDominant(question)
    ? '知识库里暂时没有找到相关内容。换个说法，或先多记录一些笔记再试。'
    : 'No relevant content was found in your knowledge base. Try rephrasing the question or add more notes first.';
}

export function noModelOutputMessageForDocuments(documents, fallbackText = '') {
  return isHanDocumentMajority(documents, fallbackText)
    ? '模型没有返回内容。'
    : 'The model returned no content.';
}
