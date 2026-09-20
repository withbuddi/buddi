/**
 * The passphrase that opens an encrypted backup.
 *
 * A backup is the whole installation, so the passphrase has to be strong
 * enough to survive an offline attack on a stolen archive, and human enough
 * that the owner will actually write it on paper. Six words from a 512-word
 * list is 54 bits, which is the number age's own documentation asks for, and
 * the list below is chosen so that a word read off a sticky note can only be
 * one word: nothing shorter than three letters, nothing longer than six, no
 * word that is a prefix of another, and no pair one keystroke apart (no
 * `bean`/`bear`, no `plane`/`planet`). Changing the list changes nothing about
 * old backups: the passphrase is the secret, not the list.
 */
import { randomInt } from 'node:crypto';

/** Where the generated passphrase is kept, for the owner who did not write it down. */
export const BACKUP_PASSPHRASE_KEY = 'backup.passphrase';

/** How many words `generatePassphrase` joins. */
export const PASSPHRASE_WORDS = 6;

/**
 * The word list. 512 entries, so each word is exactly 9 bits.
 *
 * Do not sort, trim or extend this in passing: the length is part of the
 * entropy claim above, and the pairwise rules are checked by the test.
 */
export const PASSPHRASE_WORDLIST: readonly string[] = [
  "able", "acid", "actor", "adult", "afraid", "agent", "alarm", "album",
  "alien", "alley", "almond", "alpha", "amber", "anchor", "angel", "angle",
  "apple", "april", "arch", "arena", "argue", "armor", "arrow", "asset",
  "atlas", "attic", "audio", "aunt", "awake", "award", "bacon", "badge",
  "bagel", "baker", "banjo", "basil", "batch", "beach", "beam", "berry",
  "bison", "black", "blade", "blast", "blend", "blink", "blue", "board",
  "bonus", "book", "boss", "bowl", "boxer", "brain", "brave", "bread",
  "brick", "broom", "brown", "brush", "bugle", "build", "bulb", "bunny",
  "buyer", "cabin", "camel", "canal", "canoe", "cargo", "cart", "cave",
  "cedar", "chain", "chalk", "charm", "chef", "chess", "child", "cider",
  "city", "civic", "clamp", "clay", "clean", "cliff", "climb", "clock",
  "cloud", "club", "coach", "coast", "cobra", "cocoa", "coin", "color",
  "comet", "comic", "coral", "cover", "crab", "craft", "crane", "cream",
  "crew", "crisp", "crop", "cross", "crowd", "cube", "curve", "cycle",
  "daily", "dance", "dawn", "deal", "deck", "deer", "delta", "denim",
  "depot", "diary", "disco", "ditch", "diver", "dodge", "donor", "drama",
  "dress", "drift", "drill", "drive", "drum", "dryer", "dust", "duty",
  "eagle", "early", "earth", "east", "echo", "edge", "eight", "elbow",
  "elder", "elite", "elk", "email", "enjoy", "entry", "equal", "equip",
  "event", "exact", "exit", "extra", "fairy", "fancy", "farm", "fault",
  "fence", "fiber", "field", "fifty", "final", "fire", "fish", "flag",
  "flame", "flash", "fleet", "float", "floor", "fluid", "flute", "focus",
  "foggy", "food", "fork", "forum", "fox", "fruit", "fuel", "game",
  "gear", "gecko", "gem", "ghost", "giant", "glass", "globe", "glow",
  "goat", "golf", "grace", "grand", "graph", "green", "grid", "group",
  "guard", "guess", "guide", "habit", "happy", "hawk", "hazel", "heart",
  "heavy", "help", "herb", "high", "hill", "hint", "honey", "hope",
  "horn", "horse", "hotel", "hour", "human", "humor", "husky", "ice",
  "idea", "image", "inch", "index", "ink", "iris", "iron", "ivory",
  "jazz", "jeans", "jelly", "jewel", "joy", "judge", "juice", "july",
  "jumbo", "kayak", "keep", "kind", "kite", "kiwi", "knee", "knife",
  "knock", "koala", "label", "lake", "large", "laser", "lava", "leaf",
  "lemon", "lens", "level", "lilac", "lily", "lime", "linen", "lion",
  "lobby", "local", "log", "lotus", "lucky", "lunar", "lunch", "lyric",
  "magic", "major", "mango", "maple", "marsh", "mask", "medal", "media",
  "melon", "menu", "merit", "metro", "mild", "mimic", "mixer", "month",
  "moon", "motor", "mouse", "movie", "mule", "music", "myth", "nacho",
  "navy", "neat", "neon", "nerve", "never", "noble", "noise", "north",
  "novel", "nurse", "oak", "oasis", "ocean", "often", "olive", "omega",
  "onion", "opera", "orbit", "organ", "otter", "oval", "oven", "page",
  "paint", "panda", "panel", "paper", "park", "party", "pasta", "path",
  "pearl", "phone", "photo", "piano", "piece", "pilot", "pine", "pixel",
  "pizza", "plane", "plaza", "plum", "poem", "polar", "pond", "pool",
  "poppy", "prism", "prize", "proof", "proud", "pulse", "queen", "quest",
  "quick", "quiet", "quote", "radar", "radio", "rapid", "raven", "razor",
  "ready", "rebel", "relax", "rich", "rifle", "rigid", "ring", "risk",
  "road", "robin", "robot", "rodeo", "rose", "round", "royal", "ruby",
  "rug", "ruler", "rural", "salad", "salt", "satin", "sauce", "saver",
  "scale", "scarf", "scene", "scout", "seven", "shark", "shelf", "shine",
  "ship", "shirt", "shock", "shoe", "silk", "siren", "size", "skate",
  "ski", "skull", "sleep", "slice", "slope", "small", "smile", "smoke",
  "snack", "snail", "snake", "sniff", "snow", "soap", "soda", "soft",
  "solid", "sonic", "south", "space", "speak", "speed", "spoon", "sport",
  "spray", "squid", "staff", "stage", "stamp", "stand", "star", "steam",
  "steel", "step", "stick", "still", "stone", "stool", "storm", "study",
  "style", "sugar", "super", "surf", "sweet", "swift", "swim", "sword",
  "syrup", "tank", "tape", "tent", "thick", "thing", "thumb", "tide",
  "tiger", "tiny", "title", "today", "tooth", "topic", "torch", "tower",
  "town", "track", "trade", "trail", "trap", "tree", "trend", "trial",
  "tribe", "trust", "truth", "tulip", "tuna", "tutor", "twin", "twist",
  "uncle", "unit", "upper", "urban", "usage", "value", "vapor", "verse",
  "video", "view", "visit", "vital", "vivid", "voice", "wagon", "wasp",
  "water", "west", "whale", "wheat", "wheel", "white", "world", "wrist",
  "yacht", "yard", "yoga", "young", "zebra", "zero", "zone", "zoom",];

/**
 * Six words joined by single spaces, drawn with `randomInt` so the draw is
 * uniform (a `% length` on a random byte would not be).
 */
export function generatePassphrase(words: number = PASSPHRASE_WORDS): string {
  const picked: string[] = [];
  for (let i = 0; i < words; i += 1) {
    picked.push(PASSPHRASE_WORDLIST[randomInt(PASSPHRASE_WORDLIST.length)]!);
  }
  return picked.join(' ');
}

/**
 * What the owner typed, made to match what we generated.
 *
 * People paste passphrases out of password managers, out of terminals that
 * wrapped them, and off paper with a double space in the middle. Both sides of
 * a comparison go through here, and so does the passphrase on its way to the
 * encrypter, so a backup written from a stored passphrase still opens when the
 * same passphrase is typed back with sloppy spacing.
 */
export function normalizePassphrase(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** True when every word of `input` is on the list — the sign of a generated one. */
export function isGeneratedPassphrase(input: string): boolean {
  const words = normalizePassphrase(input).split(' ');
  if (words.length !== PASSPHRASE_WORDS) return false;
  return words.every((word) => PASSPHRASE_WORDLIST.includes(word));
}
