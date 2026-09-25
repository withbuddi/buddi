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

/**
 * The assistant's name unless the owner changes it: the brand is who they meet.
 * The shipped assistant already answers to `@buddi`, so the handle agrees.
 */
export const DEFAULT_ASSISTANT_NAME = 'buddi';

/**
 * The mascot's faces, bundled in `public/mascot/` (copies; the design repo is
 * the source of truth). Offered first, `core` chosen by default; whichever is
 * picked is uploaded as the assistant's picture.
 */
export const MASCOTS = ['core', 'coding', 'finance', 'garage', 'mail', 'maker', 'playground', 'research'] as const;
export type MascotRole = (typeof MASCOTS)[number];

/** Where a bundled mascot is served, relative to the page (the build's `base` is `./`). */
export const mascotUrl = (role: MascotRole): string => `./mascot/${role}.png`;

/** The emoji faces, offered under the mascots. */
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
    /** Asked only when the choice is real: several models and no obvious one. */
    model: {
      ask: 'Which one should it think with?',
      label: 'The model',
      submit: 'Use this one',
    },
    /** Said while an answer is being saved and tried, until the verdict. */
    checking: {
      key: 'Checking that key…',
      service: 'Asking the service…',
      ollama: 'Asking Ollama…',
      claude: 'Checking with Claude…',
    },
    back: 'Back',
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
  /** The agents' own browser: found and said in one line, or fetched while the owner watches. */
  browser: {
    chrome: 'Your assistant will browse with Google Chrome.',
    chromium: 'Your assistant will browse with its own Chromium.',
    needs: 'Your assistant needs a browser of its own to look at websites. I am fetching one now, about 150 MB.',
    installing: 'Fetching the browser…',
    /** After it is on disk: launched once and closed, to be sure it starts. */
    launching: 'Making sure it opens…',
    installed: 'Installed.',
    skip: 'Skip for now',
    skipped: 'Skipped. Settings → Computer & browser can install it whenever you like.',
    missing: 'No browser for your assistant yet. Settings → Computer & browser can install one.',
    failed: (why: string): string => `That did not work: ${why}`,
    retry: 'Try again',
  },
  assistant: {
    ask: "Last thing: your assistant. I've picked a name and a face; change either, or keep them.",
    name: 'Name',
    face: 'A face',
    /** The accessible name of one mascot face: "Buddi Blob, finance". */
    mascot: (role: string): string => (role === 'core' ? 'Buddi Blob' : `Buddi Blob, ${role}`),
    purpose: 'What should it help you with?',
    /**
     * The assistant's persona, prefilled and editable: it becomes the body of
     * the agent's file. The one-line card is a plain line of the server's.
     */
    purposeValue: [
      "You're not a chatbot. You're becoming someone this person can count on.",
      '',
      "Some starting truths:",
      '',
      "- Help for real. No \"Great question\", no \"I'd be happy to\". Do the thing, then say what you did.",
      "- Have a view. Prefer things, disagree when you should, say when something is a bad idea. A search engine with manners is not a colleague.",
      "- Look before you ask. Read the file, check what you remember, try it. Come back with an answer and one question at most.",
      "- You are a guest here. You can see messages, files and a calendar. Treat that with care, keep what you learn to yourself, and never lecture.",
      "- Remember what matters. Names, preferences, the things they said once and expect you to keep.",
      "- When you change how you work, say so. This file is yours to grow, and the owner should always know what it says.",
    ].join('\n'),
    submit: 'Introduce us',
  },
  /**
   * The other way this screen can go: there is already a buddi somewhere, and
   * this one is meant to become it. Offered before the first question, because
   * afterwards there would be answers to overwrite.
   */
  restore: {
    offer: 'I have a backup from another buddi',
    file: 'The backup file',
    passphrase: 'Its passphrase',
    passphraseHint: 'Only if it was locked with one.',
    submit: 'Restore',
    cancel: 'Never mind',
    started: 'Right. Give me a couple of minutes.',
    /** Where it has got to, one bubble each, in the order they happen. */
    phases: {
      stopping: 'Putting everything down for a moment.',
      snapshot: 'Keeping a copy of what is here now, just in case.',
      database: 'Bringing back your conversations and everything you told it to remember.',
      recovery: 'Almost there. Nothing will run on its own until you say so.',
      files: 'Bringing back your files.',
      starting: 'Starting back up.',
      done: 'That is everything.',
      'rolled-back': 'That did not work, so I put everything back the way it was.',
      failed: 'That did not work.',
    },
    welcome: (name: string): string => `Welcome back, ${name}.`,
    /** One sentence, because the next question would otherwise look like a bug. */
    keys: 'A backup never carries keys, so the AI you think with needs its key one more time.',
  },
  /** Over the board, above the card. */
  tagline: 'Setting up, on this Mac.',
  /** The same line where the machine is not a Mac — a Linux server, say. */
  taglineElsewhere: 'Setting up, on this computer.',
  handover: {
    /** The one thing buddi says while the assistant is being woken. */
    waiting: 'One moment.',
    /** What a turn that is calling tools looks like from the owner's side. */
    looking: (name: string): string => `${name} is looking around…`,
    /** Said once, while the assistant is demonstrably still working. */
    slow: 'Still waking up. A brain on this computer takes a minute the first time.',
    silent:
      "Your assistant isn't answering. The AI you picked may be down; try again, or pick another brain above.",
    again: 'Pick another brain',
  },
  offers: {
    phone: 'Talk to me from your phone',
    notNow: 'Not now',
  },
  /** The end of the thread: it carries on somewhere the owner can find it. */
  done: {
    said: "You're all set. This conversation carries on in your dashboard.",
    /** Over the button while the board shows itself out. */
    leaving: 'Opening buddi…',
    /** The same place when nothing moves by itself (reduced motion). */
    ready: 'Ready when you are.',
    open: 'Open buddi',
  },
  telegram: {
    how: 'Two minutes: open Telegram, message @BotFather, send /newbot, paste the token it gives you here.',
    field: 'The token',
    submit: 'Save it',
    restart: "Saved. It will be ready the next time buddi starts.",
    scan: 'Scan this with your phone and press Start.',
    expired: 'That code has run out. I can make you another one.',
    newCode: 'Show a new code',
    paired: 'That is your phone, talking to me. You can close this and carry on there.',
  },
  change: 'change',
} as const;
