/**
 * What buddi says, and every other word on the first-run screen.
 *
 * One file, because the screen is a script before it is a component: the
 * sentences are the design (docs/onboarding.md §2, the kit's `Setup.jsx`), and keeping them together
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

/** The Blob's moving states, drawn as Lottie loops (`public/mascot/anim/`, copies of the design repo's). */
export type MascotAnimState = 'idle' | 'working';

/** The roles that have loops so far; any other role keeps its still. */
const ANIMATED_ROLES: readonly MascotRole[] = ['core'];

/** Where a role's loop is served, or null when that role has none yet. */
export const mascotAnimUrl = (role: MascotRole, state: MascotAnimState): string | null =>
  ANIMATED_ROLES.includes(role) ? `./mascot/anim/${role}-${state}.json` : null;

/** The emoji faces, offered under the mascots. */
export const FACES = ['🙂', '📚', '🧭', '🦊', '🛟', '🌿', '🛠️', '🎧'] as const;

/** What the assistant is asked to say before the owner has said anything. */
export const OPENING_INSTRUCTION =
  'Introduce yourself by name and say one thing you can do today.';

/** The five chapters, as the map names them. */
export const CHAPTER_NAMES = ['Hello', 'A brain', 'What I take on', 'Reach me', 'Your assistant'] as const;

/** "A, B and C" — and, with `comma`, "A, B, and C". */
export const and = (items: readonly string[], comma = false): string =>
  items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')}${comma && items.length > 2 ? ', and ' : ' and '}${items[items.length - 1]}`;

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const NUMBER = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

/** The six outcomes of chapter 3, in the order the tiles are drawn. */
export const TAKE_ON = [
  { id: 'days', title: 'My days', plugins: 'Weather · Calendar', line: 'Weather and your calendars, for a brief every morning.', note: 'Weather needs nothing. Calendar asks for your calendar’s private link in chapter 4.' },
  { id: 'mail', title: 'My mail', plugins: 'Mail Triage (built in)', line: 'Mail Triage reads new mail and brings you only what needs you.', mate: 'Mail Triage', note: 'Mail asks for a mailbox in chapter 4.' },
  { id: 'money', title: 'My money', plugins: 'Finance', line: 'Accounts, cards and cash flow, kept on this computer.', note: 'Finance reads the statements you hand it; no bank sign-in.' },
  { id: 'voice', title: 'Voice', plugins: 'Speech', line: 'Talk to me and hear me back, here and on your phone. Runs on this computer.', note: 'Speech needs nothing.' },
  { id: 'code', title: 'My code', plugins: 'Developer', line: 'Developer works in one folder you name, and shows you what it changed.', mate: 'Developer', note: 'Developer asks for its folder the first time you talk.' },
  { id: 'pictures', title: 'Pictures', plugins: 'Image', line: 'One picture from a prompt, with an account you pick.', note: 'Image asks which account to draw with.' },
] as const;
export type TakeOnTile = (typeof TAKE_ON)[number]['id'];

/** On when the chapter opens for the first time. */
export const TAKE_ON_DEFAULT: readonly TakeOnTile[] = ['days', 'mail'];

/** The five colours a face can take: the agent accents, each with its Blob. */
export const COLOURS = [
  { id: 'buddi', role: 'core', label: 'Blue' },
  { id: 'mail', role: 'mail', label: 'Orange' },
  { id: 'finance', role: 'finance', label: 'Green' },
  { id: 'coding', role: 'coding', label: 'Violet' },
  { id: 'research', role: 'research', label: 'Purple' },
] as const satisfies ReadonlyArray<{ id: string; role: MascotRole; label: string }>;
export type ColourId = (typeof COLOURS)[number]['id'];

export const SCRIPT = {
  /** Over the map, under the name. */
  tagline: 'Setting up, on this Mac.',
  /** The same line where the machine is not a Mac — a Linux server, say. */
  taglineElsewhere: 'Setting up, on this computer.',
  chapters: CHAPTER_NAMES,
  /** Under each chapter's map, one note, in the chapter's order. */
  mapNotes: [
    'Two minutes. Everything can be changed later in Settings, and nothing leaves this computer until you say so.',
    'One line decides which company sees your assistant’s conversations. You can add more brains later and give each agent its own.',
    'Each choice installs a plugin from withbuddi.com. At the end I suggest teammates for what you picked; nothing runs until you have read its card, and you can say no to any of them.',
    'All three are optional. The mailbox is what “My mail” needs; the phone is how I reach you when you are away.',
    'The persona is a plain text file the assistant grows over time. Keep it, rewrite it, or let Agent Father write one after an interview.',
  ],
  /** The dock: where you are, and the way back. */
  count: (n: number): string => `Chapter ${n} of 5`,
  back: 'Back',
  change: 'change',
  later: 'Set up later',
  /** Back to the first chapter; nothing already connected is undone. */
  startOver: {
    link: 'Start over',
    /** Said in chapter 1 again, only when something stays. */
    said: (kept: string): string =>
      `Starting again. What you already connected stays in Settings: ${kept}.`,
    telegram: 'Telegram',
    browser: 'the browser',
  },
  /** The phone strip's dots. */
  strip: (n: number, name: string): string => `${n} · ${name}`,

  /* ---- chapter 1 ---- */
  hello: {
    title: 'Hi. I’m buddi.',
    opening: [
      'I live on this computer and I’m about to introduce you to your first assistant. Nothing you tell me leaves this machine, except what your assistant sends to the AI you pick next.',
      'First, what should we call you, and what time is it where you are?',
    ],
    foot: 'Your agents use your name in every reply, and your clock for reminders and the morning brief.',
    submit: 'That’s me',
    /** What the map says once it is answered, under the name. */
    answer: (name: string): string => name,
  },
  name: {
    label: 'Your first name',
    placeholder: 'Sam',
  },
  clock: {
    label: 'Your clock',
    /** The zone is the browser's own; the time is now, there. */
    hint: (time: string): string => `What this browser says. ${time} right now.`,
    change: 'Change',
  },

  /* ---- chapter 2 ---- */
  brain: {
    title: 'Which AI should your team think with?',
    ask: 'Pick what you already have. I test it with one small call before we go on.',
    submit: 'Use this brain',
    /** The five cards, in the kit's order. */
    cards: {
      free: { title: 'Free to start, no key', line: 'Ollama Cloud, one tap. Good enough to meet your assistant today.', pill: 'Recommended to begin' },
      claude: { title: 'I pay for Claude', line: 'Sign in with your Claude account. Uses its extra usage.' },
      chatgpt: { title: 'I pay for ChatGPT', line: 'Sign in with a code on openai.com. Uses your plan.' },
      key: { title: 'I have an API key', line: 'Anthropic, OpenAI, Google AI, or another service with an address.' },
      local: { title: 'On this computer', line: 'Free and private. Looking on this computer…' },
    },
    /** Which kind of key, under the key card. */
    keyKinds: {
      label: 'Which key',
      key: 'Anthropic or OpenAI',
      gemini: 'Google AI',
      service: 'Another service',
    },
    claude: {
      label: 'Claude',
      start: 'Sign in with Claude',
      open: 'Open the Claude sign-in page',
      paste: 'Paste what Claude gave you',
      finish: 'Done',
      waiting: 'Sign in on the claude.ai page that just opened, then paste the code Claude shows you.',
    },
    /** ChatGPT: buddi shows a code, the owner enters it on openai.com, buddi notices. */
    chatgpt: {
      /** What the account is called, in Settings and on the map. */
      label: 'ChatGPT',
      /** Before the page is open: in the order the owner does it. The code is in the field under it, once. */
      instruct: 'Open openai.com, type this code there and approve buddi. I’ll notice.',
      /** Once the page is open. */
      waiting: 'Waiting for your approval…',
      /** Approved: who signed in, when ChatGPT said. */
      signedIn: (account: string | null): string => (account ? `Signed in as ${account}.` : 'Signed in.'),
      code: 'Your code',
      open: 'Open openai.com',
      again: 'Try again',
      failed: 'The sign-in did not finish. Try again.',
    },
    /** Ollama Cloud with a device key: the owner presses Connect on ollama.com, buddi notices. */
    cloud: {
      /** What the account is called, in Settings and on the map. */
      label: 'Ollama Cloud',
      waiting: 'Press Connect on the ollama.com page that just opened. Sign in there first if it asks. I’ll notice.',
      open: 'Open the ollama.com page',
      again: 'Try again',
    },
    /** Gemini with a Google AI Studio key: one field, and a link to where keys are made. */
    gemini: {
      label: 'Gemini',
      field: 'Your Google AI key',
      placeholder: 'Paste it here',
      submit: 'Use this key',
      get: 'Get a key at aistudio.google.com',
    },
    key: {
      field: 'Your key',
      placeholder: 'Paste it here',
      hint: 'I can tell which AI it belongs to from the key. It stays on this computer.',
      submit: 'Use this key',
      which: 'Not right?',
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      refused: 'That key was refused. Check it and paste it again.',
    },
    /** The "On this computer" card: what the gateway found here, Ollama, mlxh, both or neither. */
    local: {
      looking: 'Free and private. Looking on this computer…',
      found: (found: { ollama?: number; mlxh?: number }): string => {
        const count = (n: number): string => (n === 1 ? 'one model' : `${n} models`);
        const names = [
          found.ollama !== undefined ? `Ollama with ${count(found.ollama)}` : null,
          found.mlxh !== undefined ? `mlxh with ${count(found.mlxh)}` : null,
        ].filter(Boolean);
        return `Free and private. I found ${names.join(' and ')}; the first answer takes a minute.`;
      },
      missing: 'Free, private, no key. Not here yet: I show you how to install Ollama and fetch a model.',
    },
    /** mlxh, the local MLX model server on a Mac: no key, the gateway's address. */
    mlxh: {
      label: 'mlxh',
      connect: 'Use mlxh',
      /** mlxh answered but serves no language model (only image ones). */
      noBrain: 'mlxh has no language model installed. Pull one with `mlxh pull`, then come back.',
    },
    ollama: {
      label: 'Ollama',
      connect: 'Use Ollama',
      download: 'Get Ollama',
      copy: 'Copy',
      copied: 'Copied',
      /** Not on this machine: the command is shown, never run. */
      missing: (machine: string): string => `Ollama isn’t on ${machine} yet. Install it, open it, and I’ll notice; I never run an installer for you.`,
      missingHow: (platform: string, machine: string): string =>
        platform === 'linux'
          ? `The official script from ollama.com. Paste it into a terminal on ${machine}.`
          : platform === 'darwin'
            ? 'In Terminal, with Homebrew. Or download the app.'
            : 'Download it from ollama.com and open it.',
      stopped: (platform: string): string =>
        `Ollama is installed but not running. Open the Ollama app${platform === 'linux' ? ', or start it with the command below' : ''}, and I’ll notice.`,
      empty: (machine: string, memoryGb: number, model: string, sizeGb: number): string =>
        `Ollama is running, with no model yet. For ${machine}’s ${Math.round(memoryGb)} GB I’d fetch ${model}: about ${sizeGb} GB, once.`,
      emptyFoot: (machine: string): string => `Free and private: it runs here, and nothing you say leaves ${machine}.`,
      fetch: (model: string): string => `Fetch ${model}`,
      fetching: (model: string, done: string, total: string): string =>
        total ? `Fetching ${model}: ${done} of ${total} GB.` : `Fetching ${model}…`,
      fetchingFoot: 'Keep this page open or not: Ollama keeps fetching, and I pick up where it is.',
      failed: (error: string): string => `The download stopped: ${error} Try again; it picks up where it was.`,
      again: 'Try again',
      /** The way out to Ollama Cloud, worded by what the machine is. */
      cloud: (why: 'memory' | 'gpu' | null, memoryGb: number): string =>
        why === 'memory'
          ? `${Math.round(memoryGb)} GB is little for a model of its own: it would be slow. Ollama Cloud runs bigger models for you, free to start.`
          : why === 'gpu'
            ? 'No graphics chip Ollama can use here: it would be slow. Ollama Cloud runs bigger models for you, free to start.'
            : 'Rather not run a model here? Ollama Cloud runs bigger models for you, free to start.',
      useCloud: 'Use Ollama Cloud instead',
      /** Said under "That works" for a brain on this computer. */
      honestTitle: 'A small model, honestly',
      honest:
        'Private and free, but slower and less able than Claude or ChatGPT: fine for chat, notes and reminders; weaker at long plans, careful tool use and code. Home shows how to add a stronger brain whenever you like.',
    },
    /** Asked only when the choice is real: several models and no obvious one. */
    model: {
      ask: 'Which one should it think with?',
      label: 'The model',
      submit: 'Use this one',
      /** The key may be fine and the model wrong: the list stays, and this tries the pick. */
      retry: 'Try again',
      /** Under "That works", for a brain with several models to pick from. */
      change: 'Think with another',
    },
    /** Said while an answer is being saved and tried, until the verdict. */
    checking: {
      key: 'Checking that key…',
      service: 'Asking the service…',
      ollama: 'Asking the first model one small question. It can take a minute.',
      cloud: 'Asking Ollama Cloud…',
      claude: 'Checking with Claude…',
      chatgpt: 'Asking ChatGPT…',
      gemini: 'Asking Gemini…',
    },
    service: {
      label: 'Another service',
      address: 'Address',
      addressPlaceholder: 'The address they gave you',
      key: 'Key',
      submit: 'Connect it',
    },
    /** One small call, and then this. */
    works: (model: string): string => `That works. Your assistant will think with ${model}.`,
    /** A free Google AI key: Pro was refused, Flash answered. */
    worksOnFlash: (model: string): string =>
      `That works. Google's free tier has no Pro allowance, so your assistant will think with ${model}; turn on billing at Google to use Pro.`,
    answer: (label: string): string => label,
  },

  /* ---- chapter 3 ---- */
  takeOn: {
    title: 'What should I take on for you?',
    ask: 'Pick a few. Each one brings a plugin and, for some, a teammate who owns that job. Skip this and I stay a plain assistant; you can add any of it later.',
    submit: 'Take these on',
    none: 'Just an assistant for now',
    /** Under the grid, when nothing is picked. */
    nothing: 'Nothing picked. I’ll be a plain assistant, and Home will offer these again.',
    builtIn: 'Mail is built in.',
    nothingToFetch: 'Nothing to fetch.',
    /** The progress line: what is being fetched, and how far along. */
    fetching: (titles: readonly string[], at: number, of: number): string =>
      `Fetching ${and(titles)} from withbuddi.com and reading them. ${at} of ${of}.`,
    ready: (titles: readonly string[]): string => `${and(titles)} ${titles.length > 1 ? 'are' : 'is'} in, read and ready.`,
    failed: (title: string, reason: string): string => `${title} did not come: ${reason}.`,
    /** The map's line under chapter 3. */
    installing: (ready: number, of: number): string => `Installing, ${ready} of ${of} ready`,
    installed: 'Installed',
    answer: (titles: readonly string[]): string => (titles.length === 0 ? 'Just an assistant' : cap(titles.join(', ').toLowerCase())),
  },

  /* ---- chapter 4 ---- */
  reach: {
    title: 'How do we reach each other?',
    ask: 'A few things, each a minute. Do the ones you want; the rest wait in Settings.',
    submit: 'Continue',
    phone: {
      title: 'Your phone, through Telegram',
      line: 'Scan the code with your phone and press Start. Approvals, voice notes and the morning brief land there.',
      setUp: 'Set up Telegram',
      /** The bot is running already: the sheet opens straight on the square. */
      pair: 'Pair your phone',
      paired: 'Paired',
      /** Under the rows, once the phone said hello. */
      hello: '✓ That is your phone, talking to me. Approvals reach you there from now on.',
    },
    mailbox: {
      title: 'A mailbox',
      forTriage: 'A mailbox, for Mail Triage',
      line: 'Gmail, iCloud, Fastmail or any IMAP account. Reading only; sending always stops at a card you approve.',
      add: 'Add a mailbox',
      sheet: 'Add a mailbox',
      added: 'Mailbox added',
      unavailable: 'Mail is not ready on this computer yet. Settings → Mail can add one later.',
    },
    /** Shown when My days was taken on in chapter 3. */
    calendar: {
      title: 'Your calendar',
      line: 'Its private link, or a Google sign-in. Reading only until you say otherwise.',
      waiting: 'Calendar is still being fetched. The button wakes up when it is in.',
      add: 'Link a calendar',
      linked: 'Calendar linked',
    },
    /** Shown when My money was taken on in chapter 3. */
    bank: {
      title: 'Your bank',
      line: 'No bank sign-in: Finance reads the statements you hand it.',
      add: 'How it works',
      later: 'After setup',
    },
    app: {
      title: 'buddi as an app, and a browser of its own',
      line: 'Keep buddi in your Dock; give your assistant Chrome or its own Chromium (150 MB) so it can look at websites.',
      install: 'Install app',
      installed: 'App installed',
      chrome: 'Use Chrome',
      chromium: 'Use its Chromium',
      fetch: 'Fetch a browser',
      ready: (engine: 'chrome' | 'chromium'): string => (engine === 'chrome' ? 'Chrome, ready' : 'Chromium, ready'),
      /** Inside buddi.app: it is in the Dock already, so no install advice. */
      inApp: {
        title: 'buddi is in your Dock, and a browser of its own',
        line: 'You’re in buddi.app already. To open it when your Mac starts, choose Start at Login in the buddi menu at the top of your screen. Give your assistant Chrome or its own Chromium (150 MB) so it can look at websites.',
        extension: 'Get the Chrome extension',
      },
    },
    /** The map's line once answered. */
    answer: (done: readonly string[]): string => (done.length === 0 ? 'Later, in Settings' : cap(done.join(', '))),
    done: { phone: 'phone paired', mailbox: 'mailbox added', app: 'app and browser' },
  },
  /** The agents' own browser, in chapter 4's third row. */
  browser: {
    chrome: 'Your assistant will browse with Google Chrome.',
    chromium: 'Your assistant will browse with its own Chromium.',
    needs: 'Your assistant needs a browser of its own to look at websites. I am fetching one now, about 150 MB.',
    installing: 'Fetching the browser…',
    /** After it is on disk: launched once and closed, to be sure it starts. */
    launching: 'Making sure it opens…',
    installed: 'Installed.',
    failed: (why: string): string => `That did not work: ${why}`,
    retry: 'Try again',
  },
  /** Telegram, from chapter 4's first row: the token first when there is no bot yet. */
  telegram: {
    sheet: 'Your phone, through Telegram',
    how: 'Two minutes: open Telegram, message @BotFather, send /newbot, paste the token it gives you here.',
    field: 'The token',
    submit: 'Save it',
    restart: "Saved. It will be ready the next time buddi starts.",
    scan: 'Scan this with your phone and press Start.',
    /** While a running bot mints the code. */
    making: 'Making a code…',
    /** Under the square, until the phone says hello. */
    waiting: 'Waiting for your Start…',
    /** …and then, live, before the sheet closes by itself. */
    pairedWith: (owner: string | undefined): string => (owner?.trim() ? `Paired with ${owner.trim()}’s phone` : 'Paired with your phone'),
    expired: 'That code has run out. I can make you another one.',
    newCode: 'Show a new code',
    close: 'Done',
    notNow: 'Not now',
  },

  /* ---- chapter 5 ---- */
  assistant: {
    title: 'Meet your assistant.',
    ask: 'I’ve picked a name, a face and a way of working. Change any of it, or keep them.',
    /** Added to the bubble when chapter 3 brought teammates. */
    team: (names: readonly string[]): string => ` Your team so far: ${and(names)}, waiting to be introduced.`,
    name: 'Name',
    face: 'A face',
    colour: 'A colour for the face',
    /** The accessible name of one swatch: "Colour: green". */
    swatch: (label: string): string => `Colour: ${label.toLowerCase()}`,
    /** The accessible name of one mascot face: "Buddi Blob, finance". */
    mascot: (role: string): string => (role === 'core' ? 'Buddi Blob' : `Buddi Blob, ${role}`),
    purpose: 'How it works',
    purposeHint: 'Plain text. It becomes the assistant’s file, which is yours from then on.',
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
    /** Above the server's refusal when an assistant already exists. */
    refusedTitle: 'You already have an assistant.',
    toAgents: 'Open Agents',
  },
  /**
   * The other way this screen can go: there is already a buddi somewhere, and
   * this one is meant to become it. Offered in chapter 1 only, because
   * afterwards there would be answers to overwrite.
   */
  restore: {
    offer: 'I have a backup',
    sheet: 'Restore from a backup',
    lede: 'Pick the backup file buddi made and type its passphrase. Your agents, memory and settings come back as they were; this chapter map is skipped.',
    file: 'Backup file',
    passphrase: 'Passphrase',
    passphraseHint: 'The one you typed when you turned backups on, if it was locked with one. I can’t recover it.',
    submit: 'Restore',
    cancel: 'Never mind',
    title: 'Bringing your buddi back.',
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
    /** One sentence, because the next chapter would otherwise look like a bug. */
    keys: 'A backup never carries keys, so the AI you think with needs its key one more time.',
  },

  /* ---- the handover ---- */
  handover: {
    /** The one thing buddi says while the assistant is being woken. */
    waiting: 'One moment.',
    /** What a turn that is calling tools looks like from the owner's side. */
    looking: (name: string): string => `${name} is looking around…`,
    /** Said once, while the assistant is demonstrably still working. */
    slow: 'Still waking up. A brain on this computer takes a minute the first time.',
    silent:
      "Your assistant isn't answering. The AI you picked may be down; try again, or pick another brain.",
    again: 'Pick another brain',
    /** The four first questions, from what chapter 3 and 4 set up. Teammates are the card under them. */
    starters: (has: { days: boolean; mail: boolean; mailbox: boolean }): string[] => [
      has.days ? 'What’s my day like?' : 'What can you do?',
      'Show me around',
      has.days ? 'Link my calendar' : has.mail && !has.mailbox ? 'Add my mailbox' : 'What do you know about me?',
      'Remind me at 9 tomorrow',
    ],
    starterLabel: 'Ask first',
    /** The warm card's title and its one paragraph. */
    waitingTitle: (count: number): string => `${NUMBER[count] ?? String(count)} ${count === 1 ? 'thing' : 'things'} still waiting.`,
    waitingBody: (lines: readonly string[]): string =>
      `${cap(and(lines, true))}. ${lines.length > 1 ? (lines.length === 2 ? 'Both are' : 'They are all') : 'It’s'} on Home whenever you like.`,
    home: 'Open Home',
  },
  /** The end of first run: it carries on somewhere the owner can find it. */
  done: {
    open: 'Open buddi',
  },
} as const;
