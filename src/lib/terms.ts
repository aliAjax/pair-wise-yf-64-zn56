export interface Term {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
}

const TERMS_KEY = 'conf-terms-v1';

const seedTerms: Term[] = [
  { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
  { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
  { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
];

export function loadTerms(): Term[] {
  if (typeof localStorage === 'undefined') return seedTerms;
  try {
    const raw = localStorage.getItem(TERMS_KEY);
    if (!raw) {
      localStorage.setItem(TERMS_KEY, JSON.stringify(seedTerms));
      return seedTerms;
    }
    return JSON.parse(raw) as Term[];
  } catch {
    return seedTerms;
  }
}

export function approveTerm(id: string): void {
  if (typeof localStorage === 'undefined') return;
  const terms = loadTerms().map((term) => (term.id === id ? { ...term, approved: true } : term));
  localStorage.setItem(TERMS_KEY, JSON.stringify(terms));
}
