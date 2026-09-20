/**
 * The plugin that breaks. Loading must report it and carry on: an owner whose
 * whole assistant stops answering because one plugin is broken has a worse
 * problem than the broken plugin.
 */
throw new Error('this fixture throws on import, on purpose');
