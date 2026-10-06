import { describe, expect, it } from 'vitest';
import { codeShare, detectLanguage, languageRetryText, messageLanguage, namesALanguage, offLanguage, profileLanguageCode } from './language.js';

const EN = 'I checked your calendar and there is nothing on Thursday, so the dinner with Marc fits well at eight. Do you want me to add it?';
const FR = "J'ai regardé ton agenda et il n'y a rien jeudi, donc le dîner avec Marc tombe bien à vingt heures. Tu veux que je l'ajoute ?";
const ES = 'He revisado tu calendario y no hay nada el jueves, así que la cena con Marc encaja bien a las ocho. ¿Quieres que la añada?';
const DE = 'Ich habe deinen Kalender geprüft und am Donnerstag ist nichts eingetragen, also passt das Abendessen mit Marc gut um acht. Soll ich es eintragen?';
const PT = 'Eu verifiquei a sua agenda e não há nada na quinta-feira, então o jantar com o Marc encaixa bem às oito. Você quer que eu adicione?';
const IT = 'Ho controllato il tuo calendario e non c’è niente giovedì, quindi la cena con Marc va bene alle otto. Vuoi che la aggiunga?';

describe('detectLanguage', () => {
  it.each([['en', EN], ['fr', FR], ['es', ES], ['de', DE], ['pt', PT], ['it', IT]])('tells %s', (code, text) => {
    expect(detectLanguage(text)).toBe(code);
  });

  it('tells Spanish from Portuguese, its closest neighbour', () => {
    expect(detectLanguage('Los resultados de la semana están muy bien y el equipo ya terminó el informe para el lunes.')).toBe('es');
    expect(detectLanguage('Os resultados da semana estão muito bons e a equipe já terminou o relatório para segunda.')).toBe('pt');
  });

  it('cannot tell from too little, and says so', () => {
    expect(detectLanguage('OK')).toBeNull();
    expect(detectLanguage('Marc, 8pm, Thursday')).toBeNull();
    expect(detectLanguage('')).toBeNull();
  });

  it('cannot tell a text that is half one language, half another', () => {
    expect(detectLanguage(`${EN} ${FR}`)).toBeNull();
  });

  it('reads a short owner message with a lower bar', () => {
    expect(detectLanguage("What's the weather like?", { minHits: 2 })).toBe('en');
    expect(detectLanguage('Quel temps fait-il à Paris ?', { minHits: 2 })).toBe('fr');
    expect(detectLanguage('Weather Paris', { minHits: 2 })).toBeNull();
  });

  it('does not count code, links, blockquotes or quoted passages', () => {
    const quoting = 'Le Monde says: "Le gouvernement a annoncé que la réforme des retraites sera votée la semaine prochaine." In short, the vote is next week and it should pass.';
    expect(detectLanguage(quoting)).toBe('en');
    expect(detectLanguage('> Le gouvernement a annoncé que la réforme sera votée la semaine prochaine.\n\nThe vote is next week, and it should pass with the votes of the centre.')).toBe('en');
    expect(detectLanguage('```\nconst la = de que el los las\n```')).toBeNull();
  });

  it('drops a complete quotation whatever its length or line breaks', () => {
    const long = `"${'Le gouvernement a annoncé que la réforme des retraites sera votée la semaine prochaine, et que les syndicats ne sont pas d’accord avec le texte. '.repeat(5)}"`;
    expect(long.length).toBeGreaterThan(400);
    expect(detectLanguage(`Here is what the paper says: ${long} In short, the vote is next week and it should pass.`)).toBe('en');
    const multiline = '“Le gouvernement a annoncé que la réforme sera votée la semaine prochaine.\n\nLes syndicats ne sont pas d’accord avec le texte et ils appellent à la grève.” In short, the vote is next week and the unions are not happy about it.';
    expect(detectLanguage(multiline)).toBe('en');
    expect(detectLanguage('« Le gouvernement a annoncé que la réforme sera votée,\net les syndicats appellent à la grève dans toute la France. » That is all there is for now, and I will keep an eye on it.')).toBe('en');
  });
});

describe('codeShare', () => {
  it('measures how much of a reply is code', () => {
    expect(codeShare('```ts\nconst total = items.reduce((sum, item) => sum + item.price, 0);\n```\nThere you go.')).toBeGreaterThan(0.6);
    expect(codeShare(EN)).toBe(0);
  });
});

describe('namesALanguage', () => {
  it('sees a requested language or a translation', () => {
    expect(namesALanguage('Answer in French please')).toBe(true);
    expect(namesALanguage('Réponds en anglais')).toBe(true);
    expect(namesALanguage('Kannst du das übersetzen?')).toBe(true);
    expect(namesALanguage('Translate this mail')).toBe(true);
    expect(namesALanguage('translate to German')).toBe(true);
  });
  it('sees an output-language instruction in its usual shapes', () => {
    expect(namesALanguage('Can you give me a Spanish summary of my schedule?')).toBe(true);
    expect(namesALanguage('answer in French')).toBe(true);
    expect(namesALanguage("en français s'il te plaît")).toBe(true);
    expect(namesALanguage('Write the mail to Ana in Spanish, please.')).toBe(true);
    expect(namesALanguage('Fais-moi une version anglaise du message')).toBe(true);
    expect(namesALanguage('Answer in German\nand keep it short')).toBe(true);
  });
  it('does not mistake a language named as a subject', () => {
    expect(namesALanguage("What's in the French news today?")).toBe(false);
    expect(namesALanguage('What happened in French politics today?')).toBe(false);
    expect(namesALanguage('Explain what happened in French politics today')).toBe(false);
    expect(namesALanguage('My German class is at six')).toBe(false);
  });
});

describe('profileLanguageCode', () => {
  it('reads the profile the way the host API does', () => {
    expect(profileLanguageCode('French')).toBe('fr');
    expect(profileLanguageCode('português')).toBe('pt');
    expect(profileLanguageCode('pt-BR')).toBe('pt');
    expect(profileLanguageCode('Japanese')).toBeNull();
    expect(profileLanguageCode(null)).toBeNull();
  });
});

describe('offLanguage', () => {
  it('fires on a Spanish reply to an English message', () => {
    expect(offLanguage(ES, 'Is there room for a dinner with Marc on Thursday evening?', null)).toEqual({ reply: 'es', target: 'English' });
    expect(languageRetryText('English')).toBe('Answer in English.');
  });
  it('is silent on French to French', () => {
    expect(offLanguage(FR, 'Est-ce que je peux caser un dîner avec Marc jeudi soir ?', null)).toBeNull();
  });
  it('is silent on a short reply and on a code reply', () => {
    expect(offLanguage('Sí, hecho. La cena está en tu calendario.', 'Add it please', null)).toBeNull();
    expect(offLanguage('```js\nconst los = las.map((el) => el.de);\nconsole.log(los);\n```\nAquí está.', 'Write it in JS', null)).toBeNull();
  });
  it('is silent when nothing anchors the answer', () => {
    expect(offLanguage(ES, 'Marc, Thursday?', null)).toBeNull();
    expect(offLanguage(ES, undefined, null)).toBeNull();
  });
  it('falls back to the profile language when the message cannot be told', () => {
    expect(offLanguage(ES, 'Marc, Thursday?', 'French')).toEqual({ reply: 'es', target: 'French' });
    expect(offLanguage(FR, 'Marc, Thursday?', 'French')).toBeNull();
  });
  it('anchors on the message over the profile when the message can be told', () => {
    expect(offLanguage(FR, 'Is there room for a dinner with Marc on Thursday evening?', 'French')).toEqual({ reply: 'fr', target: 'English' });
  });
  it('leans on the profile only for a short message', () => {
    // Dutch: none of the six, long enough to be a language of its own.
    const dutch = 'Is er donderdagavond nog ruimte voor een etentje met Marc bij het restaurant aan de gracht?';
    expect(offLanguage(EN, dutch, 'French')).toBeNull();
    expect(offLanguage(EN, 'Marc, Thursday?', 'French')).toEqual({ reply: 'en', target: 'French' });
  });
  it('reads the message from its opening, not a pasted article', () => {
    const article = 'The government announced on Monday that the pension reform will be put to a vote next week. The unions said they were not happy with the text and that they would call for a strike if it passed without changes. ';
    const ask = `Résume cet article pour moi, s'il te plaît, en quelques lignes :\n\n${article.repeat(3)}`;
    expect(messageLanguage(ask)).toBe('fr');
    expect(offLanguage(FR, ask, null)).toBeNull();
    expect(offLanguage(EN, ask, null)).toEqual({ reply: 'en', target: 'French' });
  });
  it('answers a Spanish request in Spanish without a rewrite', () => {
    expect(offLanguage(ES, 'Can you give me a Spanish summary of my schedule?', null)).toBeNull();
    expect(offLanguage(FR, 'What happened in French politics today?', null)).toEqual({ reply: 'fr', target: 'English' });
  });
  it('leaves the choice to the owner who asked for a language, now or earlier', () => {
    expect(offLanguage(ES, 'Tell me in Spanish what is on for Thursday evening', null)).toBeNull();
    expect(offLanguage(ES, 'Is there room for a dinner with Marc on Thursday evening?', null, 'From now on answer in Spanish.')).toBeNull();
  });
});
