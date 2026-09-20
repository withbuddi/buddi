/**
 * What buddi says, and every other word on the first-run screen.
 *
 * One file, because the screen is a script before it is a component: the
 * sentences are the design (docs/onboarding.md §2), and keeping them together
 * is what lets a test read them all and a person read them aloud.
 *
 * The rule in §1 is enforced next door in `script.test.ts`: the words a
 * non-developer does not use do not appear here. Anything added to this file
 * is checked against that list.
 */

/** Words that belong to the people who built this, not to the person using it. */
export const BANNED_WORDS = [
  'loopback',
  'vault',
  'provider',
  'endpoint',
  'handle',
  'credential',
] as const;

/** The names buddi offers for the assistant, rotated through. */
export const SUGGESTED_NAMES = ['Ada', 'Sam', 'Noor', 'Kit', 'Juno', 'Remy'] as const;

/** The faces, unchanged from the screen this replaces. */
export const FACES = ['🙂', '📚', '🧭', '🦊', '🛟', '🌿', '🛠️', '🎧'] as const;

/** What the assistant is asked to say before the owner has said anything. */
export const OPENING_INSTRUCTION =
  'Introduce yourself by name, say one thing you can do today, and ask one question.';

export const SCRIPT = {
  opening: [
    "Hi. I'm buddi. I live on this computer, and I'm about to introduce you to your first assistant.",
    'Nothing you tell me leaves this machine, except what your assistant sends to the AI you pick in a minute.',
  ],
  later: 'Set up later',
  name: {
    ask: 'First, what should we call you?',
    placeholder: 'Your first name',
    submit: "That's me",
  },
  clock: {
    /** The zone is the browser's own; the sentence is buddi's. */
    ask: (name: string, zone: string): string =>
      `Nice to meet you, ${name}. I'll set your clock to ${zone}, which is what this browser says. Right?`,
    yes: 'Yes',
    another: 'Pick another',
    label: 'Your clock',
    answer: (zone: string): string => zone,
  },
  brain: {
    ask: 'Your assistant needs a brain: an AI it thinks with. Which of these do you already have?',
    cards: {
      claude: { title: 'Claude', line: 'I pay for Claude' },
      key: { title: 'A key from Anthropic or OpenAI', line: 'I have an API key' },
      ollama: { title: 'Ollama', line: 'Free, on this computer' },
      service: { title: 'Ollama Cloud, or another service', line: 'I have an address and a key' },
    },
    claude: {
      start: 'Sign in with Claude',
      open: 'Open the Claude sign-in page',
      paste: 'Paste what Claude gave you',
      finish: 'Done',
      waiting: 'Sign in, then paste the code Claude shows you.',
    },
    key: {
      field: 'Your key',
      placeholder: 'Paste it here',
      submit: 'Use this key',
      which: 'Not right?',
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      refused: 'That key was refused. Check it and paste it again.',
    },
    ollama: {
      found: 'Found it, running now',
      missing: 'Install Ollama, then come back',
      connect: 'Use Ollama',
      download: 'Get Ollama',
      looking: 'Looking for it on this computer…',
    },
    service: {
      address: 'Address',
      addressPlaceholder: 'The address they gave you',
      key: 'Key',
      submit: 'Connect it',
    },
    /** One small call, and then this. */
    works: (model: string): string => `That works. Your assistant will think with ${model}.`,
    /** Anything else that went wrong, in its own words. */
    refused: (why: string): string => why,
    answer: (label: string): string => label,
  },
  assistant: {
    ask: "Last thing: your assistant. I've picked a name and a face; change either, or keep them.",
    name: 'Name',
    face: 'A face',
    purpose: 'What should it help you with?',
    purposeValue: 'Whatever I ask, and remembering what I tell it.',
    submit: 'Introduce us',
  },
  handover: {
    /** The one thing buddi says while the assistant is being woken. */
    waiting: 'One moment.',
    silent:
      "Your assistant isn't answering. The AI you picked may be down; try again, or pick another brain above.",
    again: 'Pick another brain',
  },
  offers: {
    phone: 'Talk to me from your phone',
    notNow: 'Not now',
  },
  telegram: {
    how: 'Two minutes: open Telegram, message @BotFather, send /newbot, paste the token it gives you here.',
    field: 'The token',
    submit: 'Save it',
    restart: "Saved. It will be ready the next time buddi starts.",
    scan: 'Scan this with your phone and press Start.',
    paired: 'That is your phone, talking to me. You can close this and carry on there.',
  },
  change: 'change',
} as const;
