/** Editing commands are instructions, never company knowledge. Model routing
 * is advisory: even a wrong record_answer classification cannot save these. */
export function isAnswerEditingRequest(text: string): boolean {
  return /\b(?:rephrase|rewrite|reword|paraphrase)\b|\b(?:edit|improve|polish|correct|fix|shorten|translate)\b.{0,100}\b(?:answer|sentence|line|wording|phrasing|grammar|words|previous|last)\b|\b(?:make|write|put|change|improve|polish)\s+(?:it|this|that|my (?:answer|sentence))\b.{0,70}\b(?:better|clearer|proper|professional|formal|simpler|english|hindi)\b|\b(?:last|previous|earlier)\s+(?:answer|sentence|line)\b.{0,60}\b(?:correction|editing|translation)\b|\b(?:better|proper|clearer)\s+(?:wording|phrasing|sentence)|(?:पिछला|पिछले|जवाब|वाक्य).{0,50}(?:सुधार|दोबारा लिख|अच्छे शब्द)|\b(?:isko|ise)\b.{0,30}\b(?:likho|sudharo)\b/i.test(text);
}

/** Revisions are always previews requiring approval. Refuse obvious changed
 * quantities/units or a command echoed as knowledge before presenting one. */
export function revisionPreview(clean: string, source: string, command: string): string | undefined {
  const text = clean.trim();
  if (!text || text.length > 800 || text === command.trim() || isAnswerEditingRequest(text)) return undefined;
  const numbers = (value: string) => [...value.replace(/(\d),(?=\d)/g, '$1').matchAll(/(?<![\p{L}\p{N}])\d+(?:\.\d+)?%?(?![\p{L}\p{N}])/gu)].map(match => match[0]).sort().join('|');
  if (numbers(text) !== numbers(source)) return undefined;
  const units = (value: string) => (value.toLowerCase().match(/\b(?:kg|kilograms?|kgs|metres?|meters?|days?|hours?|inr|rupees?)\b/g) ?? []).map(unit => unit.replace(/kilograms?|kgs/, 'kg').replace(/meters?|metres?/, 'metre').replace(/days?/, 'day').replace(/hours?/, 'hour').replace(/rupees?/, 'inr')).sort().join('|');
  if (units(text) !== units(source)) return undefined;
  const negative = (value: string) => /\b(?:not|no|cannot|can't|don't|doesn't|won't|never|without)\b/i.test(value);
  if (negative(text) !== negative(source)) return undefined;
  return text;
}
