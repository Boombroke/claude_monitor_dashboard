/**
 * tailer.test.ts — TranscriptTailer 单测（node:test + node:assert）。
 *
 * 全程使用系统 tmpdir 下的临时目录，绝不触碰真实 ~/.claude。
 * 通过 CCMON_CLAUDE_DIR 让 loadConfig 把 projectsDir 指到临时目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptTailer, slugFromCwd } from '../src/watch/transcriptTailer.ts';
import { loadConfig } from '../src/config.ts';
import type { Config, TranscriptMarkers } from '../src/types.ts';

const SESSION = '11111111-2222-3333-4444-555555555555';
const CWD = '/Users/tester/Documents/demo';

/** 建一个临时 claudeDir，返回 { cfg, projectsDir, transcriptPath, cleanup }。 */
function setup(): {
  cfg: Config;
  transcriptPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'ccmon-tailer-'));
  const prevEnv = process.env.CCMON_CLAUDE_DIR;
  process.env.CCMON_CLAUDE_DIR = root;
  const cfg = loadConfig();
  // 还原 env（cfg 已把路径固化，无需保留 env 污染其它测试）。
  if (prevEnv === undefined) delete process.env.CCMON_CLAUDE_DIR;
  else process.env.CCMON_CLAUDE_DIR = prevEnv;

  const slug = slugFromCwd(CWD);
  const projDir = join(cfg.projectsDir, slug);
  mkdirSync(projDir, { recursive: true });
  const transcriptPath = join(projDir, `${SESSION}.jsonl`);

  return {
    cfg,
    transcriptPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 拼一条 JSONL 行。 */
function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

test('slugFromCwd 复刻实测规则：/ . _ → -', () => {
  assert.equal(slugFromCwd('/Users/mondo/Documents'), '-Users-mondo-Documents');
  assert.equal(slugFromCwd('/Users/a.b/c_d/e'), '-Users-a-b-c-d-e');
});

test('track() bootstrap 抽取 title/prompt/model/stop_reason/turnDoneMarkerAt', async () => {
  const { cfg, transcriptPath, cleanup } = setup();
  try {
    const ts = '2026-07-14T03:20:27.334Z';
    const content =
      line({ type: 'ai-title', aiTitle: 'My Session Title', sessionId: SESSION }) +
      line({ type: 'last-prompt', lastPrompt: 'please build the thing', sessionId: SESSION }) +
      line({
        type: 'assistant',
        timestamp: ts,
        cwd: CWD,
        gitBranch: 'main',
        sessionId: SESSION,
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'All done, over to you.' }],
        },
      }) +
      line({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 4200,
        messageCount: 3,
        timestamp: '2026-07-14T03:20:28.000Z',
        cwd: CWD,
        gitBranch: 'main',
        sessionId: SESSION,
      });
    writeFileSync(transcriptPath, content);

    const captured: TranscriptMarkers[] = [];
    const tailer = new TranscriptTailer(cfg, { onMarkers: (m) => captured.push(m) });

    tailer.track(SESSION, CWD);
    // bootstrap 是异步的：等它跑完。
    await tailer.refresh(SESSION);

    assert.ok(captured.length >= 1, 'onMarkers 应至少被调用一次');
    const last = captured[captured.length - 1]!;
    assert.equal(last.sessionId, SESSION);
    assert.equal(last.currentTitle, 'My Session Title');
    assert.equal(last.lastPrompt, 'please build the thing');
    assert.equal(last.model, 'claude-opus-4-8');
    assert.equal(last.lastStopReason, 'end_turn');
    assert.equal(last.cwd, CWD);
    assert.equal(last.gitBranch, 'main');
    assert.equal(last.lastAssistantSummary, 'All done, over to you.');
    // turnDoneMarkerAt = 最近完成标记（turn_duration 的 ts）
    assert.equal(last.turnDoneMarkerAt, Date.parse('2026-07-14T03:20:28.000Z'));
    assert.equal(last.lastRecordAt, Date.parse('2026-07-14T03:20:28.000Z'));
  } finally {
    cleanup();
  }
});

test('增量 refresh() 追上新增行，stop_reason 更新为 tool_use', async () => {
  const { cfg, transcriptPath, cleanup } = setup();
  try {
    writeFileSync(
      transcriptPath,
      line({
        type: 'assistant',
        timestamp: '2026-07-14T03:20:27.334Z',
        cwd: CWD,
        sessionId: SESSION,
        message: { model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
      }),
    );

    const captured: TranscriptMarkers[] = [];
    const tailer = new TranscriptTailer(cfg, { onMarkers: (m) => captured.push(m) });
    tailer.track(SESSION, CWD);
    await tailer.refresh(SESSION);
    assert.equal(captured[captured.length - 1]!.lastStopReason, 'end_turn');

    // 追加一条 tool_use 的 assistant 记录。
    appendFileSync(
      transcriptPath,
      line({
        type: 'assistant',
        timestamp: '2026-07-14T03:24:34.820Z',
        cwd: CWD,
        sessionId: SESSION,
        message: { model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] },
      }),
    );
    await tailer.refresh(SESSION);

    const last = captured[captured.length - 1]!;
    assert.equal(last.lastStopReason, 'tool_use');
    assert.equal(last.lastRecordAt, Date.parse('2026-07-14T03:24:34.820Z'));
  } finally {
    cleanup();
  }
});

test('away_summary 记录填充 lastAssistantSummary 并记为完成标记', async () => {
  const { cfg, transcriptPath, cleanup } = setup();
  try {
    const summaryTs = '2026-07-13T09:42:07.060Z';
    writeFileSync(
      transcriptPath,
      line({
        type: 'system',
        subtype: 'away_summary',
        content: 'We fixed the bug; next step is for you to refresh and verify.',
        timestamp: summaryTs,
        cwd: CWD,
        sessionId: SESSION,
      }),
    );
    const captured: TranscriptMarkers[] = [];
    const tailer = new TranscriptTailer(cfg, { onMarkers: (m) => captured.push(m) });
    tailer.track(SESSION, CWD);
    await tailer.refresh(SESSION);
    const last = captured[captured.length - 1]!;
    assert.equal(last.lastAssistantSummary, 'We fixed the bug; next step is for you to refresh and verify.');
    assert.equal(last.turnDoneMarkerAt, Date.parse(summaryTs));
  } finally {
    cleanup();
  }
});

test('截断/轮转：文件被改短后不崩，标记仍能解析', async () => {
  const { cfg, transcriptPath, cleanup } = setup();
  try {
    // 先写一个较长文件。
    let big = '';
    for (let i = 0; i < 20; i++) {
      big += line({ type: 'ai-title', aiTitle: `Title ${i}`, sessionId: SESSION });
    }
    writeFileSync(transcriptPath, big);

    const captured: TranscriptMarkers[] = [];
    const tailer = new TranscriptTailer(cfg, { onMarkers: (m) => captured.push(m) });
    tailer.track(SESSION, CWD);
    await tailer.refresh(SESSION);
    assert.equal(captured[captured.length - 1]!.currentTitle, 'Title 19');

    // 用更短内容重写（size < offset → 触发截断重扫）。
    writeFileSync(
      transcriptPath,
      line({ type: 'ai-title', aiTitle: 'Fresh Title', sessionId: SESSION }),
    );
    await tailer.refresh(SESSION);

    const last = captured[captured.length - 1]!;
    assert.equal(last.sessionId, SESSION);
    assert.equal(last.currentTitle, 'Fresh Title');
  } finally {
    cleanup();
  }
});

test('回退扫描：slug 猜测未命中时按 readdir 找 <sessionId>.jsonl', async () => {
  const { cfg, transcriptPath, cleanup } = setup();
  try {
    writeFileSync(transcriptPath, line({ type: 'ai-title', aiTitle: 'Found via scan', sessionId: SESSION }));
    const captured: TranscriptMarkers[] = [];
    const tailer = new TranscriptTailer(cfg, { onMarkers: (m) => captured.push(m) });
    // 传入一个错误的 cwd，使 slug 猜测落空，强制走回退扫描。
    tailer.track(SESSION, '/totally/wrong/path');
    await tailer.refresh(SESSION);
    const last = captured[captured.length - 1]!;
    assert.equal(last.currentTitle, 'Found via scan');
  } finally {
    cleanup();
  }
});

test('文件尚不存在时不抛出，出现后可解析', async () => {
  const { cfg, transcriptPath, cleanup } = setup();
  try {
    const captured: TranscriptMarkers[] = [];
    const tailer = new TranscriptTailer(cfg, { onMarkers: (m) => captured.push(m) });
    tailer.track(SESSION, CWD);
    await tailer.refresh(SESSION); // 文件不存在：不应抛，也不应 emit
    assert.equal(captured.length, 0);

    writeFileSync(transcriptPath, line({ type: 'ai-title', aiTitle: 'Later', sessionId: SESSION }));
    await tailer.refresh(SESSION);
    assert.ok(captured.length >= 1);
    assert.equal(captured[captured.length - 1]!.currentTitle, 'Later');
  } finally {
    cleanup();
  }
});
