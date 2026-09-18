import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { answerQuestion, askQuestion, openQuestion } from './store.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_questions_test_${process.pid}`;
const NOW = new Date('2026-09-17T20:00:00Z');

suite('structured questions (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let conversationId: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.questions, core.conversations cascade');
    const { rows } = await pool.query(
      `insert into core.conversations (agent_id) values ('ledger') returning id`,
    );
    conversationId = String(rows[0].id);
  });

  const ask = () => askQuestion(pool, {
    agentId: 'ledger',
    conversationId,
    question: 'Which account?',
    options: [
      { label: 'Checking', hint: 'Best match', recommended: true },
      { label: 'Savings', hint: null, recommended: false },
    ],
    allowOther: true,
    now: NOW,
  });

  it('persists and atomically answers an exact option once', async () => {
    const question = await ask();
    expect((await openQuestion(pool, { conversationId, now: NOW }))?.id).toBe(question.id);
    const option = question.options[0]!;
    const answers = await Promise.all([
      answerQuestion(pool, { id: question.id, answer: option.label, optionId: option.id, via: 'web', now: NOW }),
      answerQuestion(pool, { id: question.id, answer: option.label, optionId: option.id, via: 'telegram', now: NOW }),
    ]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(await openQuestion(pool, { conversationId, now: NOW })).toBeNull();
  });

  it('rejects a label that was not bound to the selected option id', async () => {
    const question = await ask();
    const result = await answerQuestion(pool, {
      id: question.id,
      answer: 'Savings',
      optionId: question.options[0]!.id,
      via: 'web',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-option' });
  });

  it('closes a superseded question before opening its replacement', async () => {
    const first = await ask();
    const second = await ask();
    expect(second.id).not.toBe(first.id);
    expect((await openQuestion(pool, { conversationId, now: NOW }))?.id).toBe(second.id);
  });
});
